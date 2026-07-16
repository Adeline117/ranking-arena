-- Keep moderation evidence private and store only stable server-issued object
-- references in content_reports. The audited pre-deploy state is empty; a
-- first install refuses any newly arrived legacy report/object instead of
-- rewriting or deleting evidence. Replays admit only the canonical contract.
--
-- Deployment contract (strict): apply
-- 20260716112300_atomic_content_report_submission.sql first, then this
-- migration, then the 20260716114500 advisory-first post-interaction lock
-- migration, and only then deploy the application routes that reserve private
-- evidence. This migration verifies its 112300 dependency before changing
-- buckets, policies, columns, or functions.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('private-report-evidence-storage:v1', 0)
);

DO $preflight$
DECLARE
  v_relation_name text;
  v_relation regclass;
  v_invalid_columns text[];
  v_missing_roles text[];
  v_report_count bigint;
  v_object_count bigint;
  v_canonical_marker boolean;
  v_expected_check text;
  v_registry regclass;
  v_service_role_oid oid;
  v_role name;
  v_privilege text;
  v_column name;
BEGIN
  FOREACH v_relation_name IN ARRAY ARRAY[
    'public.content_reports',
    'public.posts',
    'public.comments',
    'public.conversations',
    'public.user_profiles',
    'storage.buckets',
    'storage.objects'
  ]::text[]
  LOOP
    v_relation := pg_catalog.to_regclass(v_relation_name);
    IF v_relation IS NULL THEN
      RAISE EXCEPTION '% must exist before private report evidence rollout', v_relation_name;
    END IF;
    IF (
      SELECT relation.relkind
      FROM pg_catalog.pg_class AS relation
      WHERE relation.oid = v_relation
    ) NOT IN ('r', 'p') THEN
      RAISE EXCEPTION '% must be a table or partitioned table', v_relation_name;
    END IF;
  END LOOP;

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
    RAISE EXCEPTION 'private report evidence roles are missing: %', v_missing_roles;
  END IF;

  IF pg_catalog.to_regprocedure('auth.role()') IS NULL OR (
    SELECT function_row.prorettype
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = pg_catalog.to_regprocedure('auth.role()')
  ) <> 'text'::regtype THEN
    RAISE EXCEPTION 'auth.role() returning text must exist';
  END IF;

  IF pg_catalog.to_regprocedure(
    'public.lock_actor_can_interact_with_post(uuid,uuid)'
  ) IS NULL OR (
    SELECT function_row.prorettype
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = pg_catalog.to_regprocedure(
      'public.lock_actor_can_interact_with_post(uuid,uuid)'
    )
  ) <> 'boolean'::regtype THEN
    RAISE EXCEPTION
      'public.lock_actor_can_interact_with_post(uuid,uuid) must return boolean';
  END IF;

  SELECT pg_catalog.array_agg(
    pg_catalog.format(
      '%I.%I.%I expected %s%s',
      required_column.schema_name,
      required_column.table_name,
      required_column.column_name,
      required_column.type_name,
      CASE WHEN required_column.required_not_null THEN ' NOT NULL' ELSE '' END
    )
    ORDER BY required_column.schema_name, required_column.table_name, required_column.ordinality
  )
  INTO v_invalid_columns
  FROM (
    VALUES
      ('public', 'content_reports', 1, 'id', 'uuid', true),
      ('public', 'content_reports', 2, 'reporter_id', 'uuid', true),
      ('public', 'content_reports', 3, 'content_type', 'text', true),
      ('public', 'content_reports', 4, 'content_id', 'text', true),
      ('public', 'content_reports', 5, 'reason', 'text', true),
      ('public', 'content_reports', 6, 'description', 'text', false),
      ('public', 'content_reports', 7, 'images', 'text[]', false),
      ('public', 'content_reports', 8, 'status', 'text', true),
      ('public', 'content_reports', 9, 'created_at', 'timestamp with time zone', false),
      ('public', 'posts', 1, 'id', 'uuid', true),
      ('public', 'posts', 2, 'author_id', 'uuid', true),
      ('public', 'comments', 1, 'id', 'uuid', true),
      ('public', 'comments', 2, 'post_id', 'uuid', true),
      ('public', 'comments', 3, 'user_id', 'uuid', true),
      ('public', 'comments', 4, 'deleted_at', 'timestamp with time zone', false),
      ('public', 'conversations', 1, 'id', 'uuid', true),
      ('public', 'conversations', 2, 'user1_id', 'uuid', true),
      ('public', 'conversations', 3, 'user2_id', 'uuid', true),
      ('public', 'user_profiles', 1, 'id', 'uuid', true),
      ('public', 'user_profiles', 2, 'banned_at', 'timestamp with time zone', false),
      ('public', 'user_profiles', 3, 'deleted_at', 'timestamp with time zone', false),
      ('storage', 'buckets', 1, 'id', 'text', true),
      ('storage', 'buckets', 2, 'name', 'text', true),
      ('storage', 'buckets', 3, 'public', 'boolean', false),
      ('storage', 'buckets', 4, 'file_size_limit', 'bigint', false),
      ('storage', 'buckets', 5, 'allowed_mime_types', 'text[]', false),
      ('storage', 'objects', 1, 'bucket_id', 'text', false),
      ('storage', 'objects', 2, 'name', 'text', false)
  ) AS required_column(
    schema_name,
    table_name,
    ordinality,
    column_name,
    type_name,
    required_not_null
  )
  LEFT JOIN pg_catalog.pg_attribute AS attribute
    ON attribute.attrelid = pg_catalog.to_regclass(
      pg_catalog.format(
        '%I.%I',
        required_column.schema_name,
        required_column.table_name
      )
    )
   AND attribute.attname = required_column.column_name
   AND attribute.attnum > 0
   AND NOT attribute.attisdropped
  WHERE attribute.attname IS NULL
     OR pg_catalog.format_type(attribute.atttypid, attribute.atttypmod)
          <> required_column.type_name
     OR (required_column.required_not_null AND NOT attribute.attnotnull);

  IF v_invalid_columns IS NOT NULL THEN
    RAISE EXCEPTION
      'private report evidence schema drift: %',
      v_invalid_columns;
  END IF;

  -- The evidence CHECK is the replay marker because it is installed only by
  -- this migration and binds reports to the reporter-scoped private reference
  -- validator. Determine the phase before validating the dependency defaults:
  -- 112300 supplies an empty-array images default on first install, while a
  -- completed 113800 install deliberately removes that default.
  SELECT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.content_reports'::regclass
      AND constraint_row.conname = 'content_reports_private_evidence_refs_check'
      AND constraint_row.contype = 'c'
      AND constraint_row.convalidated
      AND NOT constraint_row.connoinherit
      AND pg_catalog.pg_get_expr(
        constraint_row.conbin,
        constraint_row.conrelid,
        true
      ) = 'content_report_evidence_refs_valid(reporter_id, images)'
  ) INTO v_canonical_marker;

  v_registry := pg_catalog.to_regclass('public.report_evidence_uploads');

  v_service_role_oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'service_role'
  );

  IF (
    SELECT pg_catalog.pg_get_expr(
      column_default.adbin,
      column_default.adrelid,
      true
    )
    FROM pg_catalog.pg_attribute AS attribute
    JOIN pg_catalog.pg_attrdef AS column_default
      ON column_default.adrelid = attribute.attrelid
     AND column_default.adnum = attribute.attnum
    WHERE attribute.attrelid = 'public.content_reports'::regclass
      AND attribute.attname = 'status'
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  ) IS DISTINCT FROM '''pending''::text' OR (
    NOT v_canonical_marker
    AND (
      SELECT pg_catalog.pg_get_expr(
        column_default.adbin,
        column_default.adrelid,
        true
      )
      FROM pg_catalog.pg_attribute AS attribute
      JOIN pg_catalog.pg_attrdef AS column_default
        ON column_default.adrelid = attribute.attrelid
       AND column_default.adnum = attribute.attnum
      WHERE attribute.attrelid = 'public.content_reports'::regclass
        AND attribute.attname = 'images'
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
    ) IS DISTINCT FROM 'ARRAY[]::text[]'
  ) OR (
    v_canonical_marker
    AND (
      EXISTS (
        SELECT 1
        FROM pg_catalog.pg_attribute AS attribute
        JOIN pg_catalog.pg_attrdef AS column_default
          ON column_default.adrelid = attribute.attrelid
         AND column_default.adnum = attribute.attnum
        WHERE attribute.attrelid = 'public.content_reports'::regclass
          AND attribute.attname = 'images'
          AND attribute.attnum > 0
          AND NOT attribute.attisdropped
      )
      OR NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid = 'public.content_reports'::regclass
          AND attribute.attname = 'images'
          AND attribute.attnum > 0
          AND NOT attribute.attisdropped
          AND attribute.attnotnull
      )
    )
  ) THEN
    RAISE EXCEPTION
      'public.content_reports status/images defaults are not at the expected 112300/113800 phase';
  END IF;

  FOREACH v_expected_check IN ARRAY ARRAY[
    'content_type = ANY (ARRAY[''post''::text, ''comment''::text, ''message''::text, ''user''::text])',
    'reason = ANY (ARRAY[''spam''::text, ''harassment''::text, ''inappropriate''::text, ''misinformation''::text, ''fraud''::text, ''other''::text])',
    'status = ANY (ARRAY[''pending''::text, ''resolved''::text, ''dismissed''::text])'
  ]::text[]
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_constraint AS constraint_row
      WHERE constraint_row.conrelid = 'public.content_reports'::regclass
        AND constraint_row.contype = 'c'
        AND constraint_row.convalidated
        AND NOT constraint_row.connoinherit
        AND pg_catalog.pg_get_expr(
          constraint_row.conbin,
          constraint_row.conrelid,
          true
        ) = v_expected_check
    ) THEN
      RAISE EXCEPTION
        'public.content_reports is missing the canonical 112300 check: %',
        v_expected_check;
    END IF;
  END LOOP;

  FOREACH v_relation_name IN ARRAY ARRAY[
    'content_reports',
    'posts',
    'comments',
    'conversations',
    'user_profiles'
  ]::text[]
  LOOP
    v_relation := pg_catalog.to_regclass(
      pg_catalog.format('public.%I', v_relation_name)
    );

    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_index AS index_metadata
      WHERE index_metadata.indrelid = v_relation
        AND index_metadata.indisunique
        AND index_metadata.indisvalid
        AND index_metadata.indisready
        AND index_metadata.indimmediate
        AND NOT index_metadata.indisexclusion
        AND index_metadata.indpred IS NULL
        AND index_metadata.indexprs IS NULL
        AND index_metadata.indnkeyatts = 1
        AND index_metadata.indnatts = 1
        AND (
          SELECT attribute.attname
          FROM pg_catalog.unnest(index_metadata.indkey)
            WITH ORDINALITY AS key_column(attnum, ordinality)
          JOIN pg_catalog.pg_attribute AS attribute
            ON attribute.attrelid = index_metadata.indrelid
           AND attribute.attnum = key_column.attnum
          WHERE key_column.ordinality = 1
        ) = 'id'
    ) THEN
      RAISE EXCEPTION
        'public.% requires the canonical 112300 unique (id) key',
        v_relation_name;
    END IF;
  END LOOP;

  -- This is an explicit semantic dependency on 112300. Refuse to bootstrap
  -- private evidence on top of a browser-readable/writable report table or a
  -- non-atomic pending-report index. This block runs before every mutation.
  IF NOT (
    SELECT relation.relrowsecurity
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = 'public.content_reports'::regclass
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index AS index_metadata
    WHERE index_metadata.indexrelid = pg_catalog.to_regclass(
      'public.uniq_content_reports_pending_reporter_content'
    )
      AND index_metadata.indrelid = 'public.content_reports'::regclass
      AND index_metadata.indisunique
      AND index_metadata.indisvalid
      AND index_metadata.indisready
      AND NOT index_metadata.indisexclusion
      AND index_metadata.indexprs IS NULL
      AND index_metadata.indnkeyatts = 3
      AND index_metadata.indnatts = 3
      AND (
        SELECT pg_catalog.array_agg(
          attribute.attname ORDER BY key_column.ordinality
        )
        FROM pg_catalog.unnest(index_metadata.indkey)
          WITH ORDINALITY AS key_column(attnum, ordinality)
        JOIN pg_catalog.pg_attribute AS attribute
          ON attribute.attrelid = index_metadata.indrelid
         AND attribute.attnum = key_column.attnum
      ) = ARRAY['reporter_id', 'content_type', 'content_id']::name[]
      AND pg_catalog.pg_get_expr(
        index_metadata.indpred,
        index_metadata.indrelid
      ) = '(status = ''pending''::text)'
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        relation.relacl,
        pg_catalog.acldefault('r', relation.relowner)
      )
    ) AS acl_entry
    WHERE relation.oid = 'public.content_reports'::regclass
      AND acl_entry.grantee NOT IN (relation.relowner, v_service_role_oid)
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(relation.relacl) AS acl_entry
    WHERE relation.oid = 'public.content_reports'::regclass
      AND acl_entry.grantee = v_service_role_oid
      AND acl_entry.is_grantable
  ) OR (
    SELECT pg_catalog.array_agg(
      DISTINCT acl_entry.privilege_type
      ORDER BY acl_entry.privilege_type
    )
    FROM pg_catalog.pg_class AS relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        relation.relacl,
        pg_catalog.acldefault('r', relation.relowner)
      )
    ) AS acl_entry
    WHERE relation.oid = 'public.content_reports'::regclass
      AND acl_entry.grantee = v_service_role_oid
  ) IS DISTINCT FROM ARRAY['DELETE', 'INSERT', 'SELECT', 'UPDATE']::text[] OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    JOIN pg_catalog.pg_class AS relation
      ON relation.oid = attribute.attrelid
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl_entry
    WHERE attribute.attrelid = 'public.content_reports'::regclass
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND acl_entry.grantee <> relation.relowner
  ) OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.content_reports'::regclass
  ) <> 1 OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.content_reports'::regclass
      AND policy.polname = 'Service role manages content reports'
      AND policy.polpermissive
      AND policy.polcmd = '*'
      AND policy.polroles = ARRAY[v_service_role_oid]::oid[]
      AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid) = 'true'
      AND pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid) = 'true'
  ) THEN
    RAISE EXCEPTION
      'public.content_reports is not at the canonical atomic service boundary; apply 20260716112300_atomic_content_report_submission.sql first';
  END IF;

  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated']::name[]
  LOOP
    FOREACH v_privilege IN ARRAY ARRAY[
      'SELECT', 'INSERT', 'UPDATE', 'DELETE',
      'TRUNCATE', 'REFERENCES', 'TRIGGER'
    ]::text[]
    LOOP
      IF pg_catalog.has_table_privilege(
        v_role,
        'public.content_reports'::regclass,
        v_privilege
      ) THEN
        RAISE EXCEPTION
          'public.content_reports still grants % to %; apply 20260716112300_atomic_content_report_submission.sql first',
          v_privilege,
          v_role;
      END IF;
    END LOOP;

    FOR v_column IN
      SELECT attribute.attname
      FROM pg_catalog.pg_attribute AS attribute
      WHERE attribute.attrelid = 'public.content_reports'::regclass
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
    LOOP
      FOREACH v_privilege IN ARRAY ARRAY[
        'SELECT', 'INSERT', 'UPDATE', 'REFERENCES'
      ]::text[]
      LOOP
        IF pg_catalog.has_column_privilege(
          v_role,
          'public.content_reports'::regclass,
          v_column,
          v_privilege
        ) THEN
          RAISE EXCEPTION
            'public.content_reports column % still grants % to %; apply 20260716112300_atomic_content_report_submission.sql first',
            v_column,
            v_privilege,
            v_role;
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;

  IF EXISTS (
    SELECT 1 FROM storage.buckets AS bucket
    WHERE bucket.id = 'reports' AND bucket.name <> 'reports'
  ) OR EXISTS (
    SELECT 1 FROM storage.buckets AS bucket
    WHERE bucket.name = 'reports' AND bucket.id <> 'reports'
  ) THEN
    RAISE EXCEPTION 'reports bucket id/name identity has drifted';
  END IF;

  IF NOT v_canonical_marker AND v_registry IS NOT NULL THEN
    RAISE EXCEPTION
      'public.report_evidence_uploads exists before the private evidence contract';
  END IF;

  IF v_canonical_marker AND v_registry IS NULL THEN
    RAISE EXCEPTION
      'private report evidence replay marker exists without its upload registry';
  END IF;

  -- CREATE TABLE IF NOT EXISTS must never bless a same-named but semantically
  -- different registry. On replay, validate all columns, defaults, and all
  -- eight constraints before any bucket, policy, function, or data mutation.
  IF v_canonical_marker AND (
    (
      SELECT relation.relkind = 'r'
        AND relation.relpersistence = 'p'
        AND NOT relation.relispartition
      FROM pg_catalog.pg_class AS relation
      WHERE relation.oid = v_registry
    ) IS NOT TRUE OR EXISTS (
      SELECT 1
      FROM (
        VALUES
          (1, 'evidence_ref', 'text', true),
          (2, 'reporter_id', 'uuid', true),
          (3, 'object_name', 'text', true),
          (4, 'mime_type', 'text', true),
          (5, 'status', 'text', true),
          (6, 'report_id', 'uuid', false),
          (7, 'expires_at', 'timestamp with time zone', true),
          (8, 'lease_token', 'uuid', false),
          (9, 'lease_expires_at', 'timestamp with time zone', false),
          (10, 'created_at', 'timestamp with time zone', true),
          (11, 'updated_at', 'timestamp with time zone', true)
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
         OR attribute.attgenerated <> ''
         OR attribute.attidentity <> ''
    ) OR (
      SELECT pg_catalog.count(*)
      FROM pg_catalog.pg_attribute AS attribute
      WHERE attribute.attrelid = v_registry
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
    ) <> 11 OR (
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
    ) IS DISTINCT FROM 'now()' OR (
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
    ) IS DISTINCT FROM 'now()' OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_attribute AS attribute
      JOIN pg_catalog.pg_attrdef AS column_default
        ON column_default.adrelid = attribute.attrelid
       AND column_default.adnum = attribute.attnum
      WHERE attribute.attrelid = v_registry
        AND attribute.attname NOT IN ('status', 'created_at', 'updated_at')
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
    ) OR (
      SELECT pg_catalog.count(*)
      FROM pg_catalog.pg_constraint AS constraint_row
      WHERE constraint_row.conrelid = v_registry
    ) <> 8 OR NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_constraint AS constraint_row
      JOIN pg_catalog.pg_index AS index_metadata
        ON index_metadata.indexrelid = constraint_row.conindid
      WHERE constraint_row.conrelid = v_registry
        AND constraint_row.conname = 'report_evidence_uploads_pkey'
        AND constraint_row.contype = 'p'
        AND constraint_row.conkey = ARRAY[1]::smallint[]
        AND constraint_row.convalidated
        AND NOT constraint_row.condeferrable
        AND NOT constraint_row.condeferred
        AND index_metadata.indrelid = v_registry
        AND index_metadata.indisprimary
        AND index_metadata.indisunique
        AND index_metadata.indisvalid
        AND index_metadata.indisready
    ) OR NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_constraint AS constraint_row
      JOIN pg_catalog.pg_index AS index_metadata
        ON index_metadata.indexrelid = constraint_row.conindid
      WHERE constraint_row.conrelid = v_registry
        AND constraint_row.conname = 'report_evidence_uploads_object_name_key'
        AND constraint_row.contype = 'u'
        AND constraint_row.conkey = ARRAY[3]::smallint[]
        AND constraint_row.convalidated
        AND NOT constraint_row.condeferrable
        AND NOT constraint_row.condeferred
        AND index_metadata.indrelid = v_registry
        AND NOT index_metadata.indisprimary
        AND index_metadata.indisunique
        AND index_metadata.indisvalid
        AND index_metadata.indisready
    ) OR NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_constraint AS constraint_row
      WHERE constraint_row.conrelid = v_registry
        AND constraint_row.conname = 'report_evidence_uploads_report_id_fkey'
        AND constraint_row.contype = 'f'
        AND constraint_row.conkey = ARRAY[6]::smallint[]
        AND constraint_row.confrelid = 'public.content_reports'::regclass
        AND constraint_row.confkey = ARRAY[(
          SELECT attribute.attnum
          FROM pg_catalog.pg_attribute AS attribute
          WHERE attribute.attrelid = 'public.content_reports'::regclass
            AND attribute.attname = 'id'
            AND attribute.attnum > 0
            AND NOT attribute.attisdropped
        )]::smallint[]
        AND constraint_row.confupdtype = 'a'
        AND constraint_row.confdeltype = 'r'
        AND constraint_row.confmatchtype = 's'
        AND constraint_row.convalidated
        AND NOT constraint_row.condeferrable
        AND NOT constraint_row.condeferred
    ) OR NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_constraint AS constraint_row
      WHERE constraint_row.conrelid = v_registry
        AND constraint_row.conname = 'report_evidence_uploads_status_check'
        AND constraint_row.contype = 'c'
        AND constraint_row.convalidated
        AND NOT constraint_row.connoinherit
        AND pg_catalog.pg_get_expr(
          constraint_row.conbin,
          constraint_row.conrelid,
          true
        ) = 'status = ANY (ARRAY[''reserved''::text, ''uploaded''::text, ''cleanup''::text, ''claimed''::text])'
    ) OR NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_constraint AS constraint_row
      WHERE constraint_row.conrelid = v_registry
        AND constraint_row.conname = 'report_evidence_uploads_mime_check'
        AND constraint_row.contype = 'c'
        AND constraint_row.convalidated
        AND NOT constraint_row.connoinherit
        AND pg_catalog.pg_get_expr(
          constraint_row.conbin,
          constraint_row.conrelid,
          true
        ) = 'mime_type = ANY (ARRAY[''image/jpeg''::text, ''image/png''::text, ''image/gif''::text, ''image/webp''::text, ''image/avif''::text])'
    ) OR NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_constraint AS constraint_row
      WHERE constraint_row.conrelid = v_registry
        AND constraint_row.conname = 'report_evidence_uploads_ref_check'
        AND constraint_row.contype = 'c'
        AND constraint_row.convalidated
        AND NOT constraint_row.connoinherit
        AND pg_catalog.pg_get_expr(
          constraint_row.conbin,
          constraint_row.conrelid,
          true
        ) = 'content_report_evidence_refs_valid(reporter_id, ARRAY[evidence_ref])'
    ) OR NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_constraint AS constraint_row
      WHERE constraint_row.conrelid = v_registry
        AND constraint_row.conname = 'report_evidence_uploads_object_check'
        AND constraint_row.contype = 'c'
        AND constraint_row.convalidated
        AND NOT constraint_row.connoinherit
        AND pg_catalog.pg_get_expr(
          constraint_row.conbin,
          constraint_row.conrelid,
          true
        ) = 'object_name = substr(evidence_ref, 9)'
    ) OR NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_constraint AS constraint_row
      WHERE constraint_row.conrelid = v_registry
        AND constraint_row.conname = 'report_evidence_uploads_lifecycle_check'
        AND constraint_row.contype = 'c'
        AND constraint_row.convalidated
        AND NOT constraint_row.connoinherit
        AND pg_catalog.pg_get_expr(
          constraint_row.conbin,
          constraint_row.conrelid,
          true
        ) = '(status = ANY (ARRAY[''reserved''::text, ''uploaded''::text])) AND report_id IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL OR status = ''cleanup''::text AND report_id IS NULL AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL OR status = ''claimed''::text AND report_id IS NOT NULL AND lease_token IS NULL AND lease_expires_at IS NULL'
    )
  ) THEN
    RAISE EXCEPTION
      'report evidence upload registry constraint contract drift detected';
  END IF;

  SELECT pg_catalog.count(*) INTO v_report_count
  FROM public.content_reports;
  SELECT pg_catalog.count(*) INTO v_object_count
  FROM storage.objects AS object_row
  WHERE object_row.bucket_id = 'reports';

  IF NOT v_canonical_marker AND (v_report_count > 0 OR v_object_count > 0) THEN
    RAISE EXCEPTION
      'private report evidence first install requires empty state (reports %, objects %); no evidence was changed',
      v_report_count,
      v_object_count;
  END IF;

  -- A replay can contain canonical reports and unsubmitted uploads. Validate
  -- every stored report and reference before replacing any catalog object.
  IF v_canonical_marker AND EXISTS (
    SELECT 1
    FROM public.content_reports AS report_row
    WHERE report_row.images IS NULL
       OR pg_catalog.cardinality(report_row.images) NOT BETWEEN 1 AND 4
       OR pg_catalog.array_position(report_row.images, NULL) IS NOT NULL
       OR (
         SELECT pg_catalog.count(DISTINCT evidence.ref)
         FROM pg_catalog.unnest(report_row.images) AS evidence(ref)
       ) <> pg_catalog.cardinality(report_row.images)
       OR EXISTS (
         SELECT 1
         FROM pg_catalog.unnest(report_row.images) AS evidence(ref)
         WHERE evidence.ref !~ (
           '^reports/' || pg_catalog.lower(report_row.reporter_id::text)
              || '/[0-9a-f]{16}\.(jpg|png|gif|webp|avif)$'
         )
       )
       OR EXISTS (
         SELECT 1
         FROM pg_catalog.unnest(report_row.images) AS evidence(ref)
         WHERE NOT EXISTS (
           SELECT 1
           FROM storage.objects AS object_row
           WHERE object_row.bucket_id = 'reports'
              AND object_row.name = pg_catalog.substr(evidence.ref, 9)
         )
       )
  ) THEN
    RAISE EXCEPTION
      'existing content report evidence violates the private reference contract';
  END IF;

  IF v_canonical_marker THEN
    IF EXISTS (
      SELECT 1
      FROM storage.objects AS object_row
      WHERE object_row.bucket_id = 'reports'
        AND NOT EXISTS (
          SELECT 1
          FROM public.report_evidence_uploads AS upload_row
          WHERE upload_row.object_name = object_row.name
        )
    ) THEN
      RAISE EXCEPTION
        'reports bucket contains an unregistered object; register it for cleanup or stop deployment';
    END IF;
  END IF;
END
$preflight$;

-- On replay, drain in-flight lifecycle operations before taking any other
-- table lock. Runtime submission/cleanup touches the registry first, so this
-- preserves that order and gives the locked recheck a stable object registry.
DO $lock_existing_registry$
BEGIN
  IF pg_catalog.to_regclass('public.report_evidence_uploads') IS NOT NULL THEN
    EXECUTE
      'LOCK TABLE public.report_evidence_uploads IN ACCESS EXCLUSIVE MODE';
  END IF;
END
$lock_existing_registry$;

LOCK TABLE public.content_reports IN ACCESS EXCLUSIVE MODE;
LOCK TABLE public.posts,
  public.comments,
  public.conversations,
  public.user_profiles
  IN ACCESS SHARE MODE;
LOCK TABLE storage.buckets IN ROW EXCLUSIVE MODE;
LOCK TABLE storage.objects IN SHARE ROW EXCLUSIVE MODE;

-- Preflight scans intentionally happen before blocking on deployment locks.
-- Repeat every evidence/data closure check after the locks so a report upload
-- that committed in that window cannot become an untracked, TTL-invisible
-- object. Existing unregistered objects are never guessed or deleted here.
DO $locked_evidence_recheck$
DECLARE
  v_canonical_marker boolean;
  v_registry regclass := pg_catalog.to_regclass(
    'public.report_evidence_uploads'
  );
  v_report_count bigint;
  v_object_count bigint;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.content_reports'::regclass
      AND constraint_row.conname = 'content_reports_private_evidence_refs_check'
      AND constraint_row.contype = 'c'
      AND constraint_row.convalidated
      AND NOT constraint_row.connoinherit
      AND pg_catalog.pg_get_expr(
        constraint_row.conbin,
        constraint_row.conrelid,
        true
      ) = 'content_report_evidence_refs_valid(reporter_id, images)'
  ) INTO v_canonical_marker;

  SELECT pg_catalog.count(*) INTO v_report_count
  FROM public.content_reports;
  SELECT pg_catalog.count(*) INTO v_object_count
  FROM storage.objects AS object_row
  WHERE object_row.bucket_id = 'reports';

  IF NOT v_canonical_marker THEN
    IF v_registry IS NOT NULL OR v_report_count > 0 OR v_object_count > 0 THEN
      RAISE EXCEPTION
        'private report evidence first install changed while acquiring locks (reports %, objects %, registry %); no evidence was changed',
        v_report_count,
        v_object_count,
        v_registry;
    END IF;
    RETURN;
  END IF;

  IF v_registry IS NULL THEN
    RAISE EXCEPTION
      'private report evidence replay marker exists without its upload registry after locking';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.content_reports AS report_row
    WHERE report_row.images IS NULL
       OR pg_catalog.cardinality(report_row.images) NOT BETWEEN 1 AND 4
       OR pg_catalog.array_position(report_row.images, NULL) IS NOT NULL
       OR (
         SELECT pg_catalog.count(DISTINCT evidence.ref)
         FROM pg_catalog.unnest(report_row.images) AS evidence(ref)
       ) <> pg_catalog.cardinality(report_row.images)
       OR EXISTS (
         SELECT 1
         FROM pg_catalog.unnest(report_row.images) AS evidence(ref)
         WHERE evidence.ref !~ (
           '^reports/' || pg_catalog.lower(report_row.reporter_id::text)
             || '/[0-9a-f]{16}\.(jpg|png|gif|webp|avif)$'
         )
       )
       OR EXISTS (
         SELECT 1
         FROM pg_catalog.unnest(report_row.images) AS evidence(ref)
         WHERE NOT EXISTS (
           SELECT 1
           FROM storage.objects AS object_row
           WHERE object_row.bucket_id = 'reports'
             AND object_row.name = pg_catalog.substr(evidence.ref, 9)
         )
       )
       OR EXISTS (
         SELECT 1
         FROM pg_catalog.unnest(report_row.images) AS evidence(ref)
         WHERE NOT EXISTS (
           SELECT 1
           FROM public.report_evidence_uploads AS upload_row
           WHERE upload_row.evidence_ref = evidence.ref
             AND upload_row.reporter_id = report_row.reporter_id
             AND upload_row.status = 'claimed'
             AND upload_row.report_id = report_row.id
         )
       )
  ) OR EXISTS (
    SELECT 1
    FROM public.report_evidence_uploads AS upload_row
    WHERE upload_row.status = 'claimed'
      AND NOT EXISTS (
        SELECT 1
        FROM public.content_reports AS report_row
        WHERE report_row.id = upload_row.report_id
          AND report_row.reporter_id = upload_row.reporter_id
          AND upload_row.evidence_ref = ANY (report_row.images)
      )
  ) THEN
    RAISE EXCEPTION
      'existing report evidence/report registry linkage changed while acquiring locks';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM storage.objects AS object_row
    WHERE object_row.bucket_id = 'reports'
      AND NOT EXISTS (
        SELECT 1
        FROM public.report_evidence_uploads AS upload_row
        WHERE upload_row.object_name = object_row.name
      )
  ) THEN
    RAISE EXCEPTION
      'reports bucket contains an unregistered object after locking; register it for cleanup or stop deployment';
  END IF;
END
$locked_evidence_recheck$;

INSERT INTO storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
) VALUES (
  'reports',
  'reports',
  false,
  2097152,
  ARRAY[
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
    'image/avif'
  ]::text[]
)
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Non-service roles cannot access report evidence"
  ON storage.objects;
CREATE POLICY "Non-service roles cannot access report evidence"
  ON storage.objects
  AS RESTRICTIVE
  FOR ALL
  TO PUBLIC
  USING (bucket_id <> 'reports' OR CURRENT_USER = 'service_role')
  WITH CHECK (bucket_id <> 'reports' OR CURRENT_USER = 'service_role');

DROP POLICY IF EXISTS "Service role manages report evidence"
  ON storage.objects;
CREATE POLICY "Service role manages report evidence"
  ON storage.objects
  AS PERMISSIVE
  FOR ALL
  TO service_role
  USING (bucket_id = 'reports')
  WITH CHECK (bucket_id = 'reports');

ALTER TABLE public.content_reports
  DROP CONSTRAINT IF EXISTS content_reports_private_evidence_refs_check;
ALTER TABLE public.content_reports
  ALTER COLUMN images DROP DEFAULT,
  ALTER COLUMN images SET NOT NULL;

DO $drop_registry_validator_dependency$
BEGIN
  IF pg_catalog.to_regclass('public.report_evidence_uploads') IS NOT NULL THEN
    ALTER TABLE public.report_evidence_uploads
      DROP CONSTRAINT IF EXISTS report_evidence_uploads_ref_check;
  END IF;
END
$drop_registry_validator_dependency$;

DO $drop_evidence_validator_overloads$
DECLARE
  v_signature regprocedure;
BEGIN
  FOR v_signature IN
    SELECT function_row.oid::regprocedure
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_namespace AS function_schema
      ON function_schema.oid = function_row.pronamespace
    WHERE function_schema.nspname = 'public'
      AND function_row.proname = 'content_report_evidence_refs_valid'
      AND function_row.prokind = 'f'
  LOOP
    EXECUTE pg_catalog.format('DROP FUNCTION %s', v_signature);
  END LOOP;
END
$drop_evidence_validator_overloads$;

CREATE FUNCTION public.content_report_evidence_refs_valid(
  p_reporter_id uuid,
  p_images text[]
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT p_reporter_id IS NOT NULL
    AND p_images IS NOT NULL
    AND pg_catalog.cardinality(p_images) BETWEEN 1 AND 4
    AND pg_catalog.array_position(p_images, NULL) IS NULL
    AND (
      SELECT pg_catalog.count(DISTINCT evidence.ref)
      FROM pg_catalog.unnest(p_images) AS evidence(ref)
    ) = pg_catalog.cardinality(p_images)
    AND NOT EXISTS (
      SELECT 1
      FROM pg_catalog.unnest(p_images) AS evidence(ref)
      WHERE evidence.ref !~ (
        '^reports/' || pg_catalog.lower(p_reporter_id::text)
          || '/[0-9a-f]{16}\.(jpg|png|gif|webp|avif)$'
      )
    )
$function$;

ALTER FUNCTION public.content_report_evidence_refs_valid(uuid, text[])
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.content_report_evidence_refs_valid(uuid, text[])
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.content_report_evidence_refs_valid(uuid, text[])
  TO service_role;

ALTER TABLE public.content_reports
  ADD CONSTRAINT content_reports_private_evidence_refs_check
  CHECK (public.content_report_evidence_refs_valid(reporter_id, images))
  NOT VALID;
ALTER TABLE public.content_reports
  VALIDATE CONSTRAINT content_reports_private_evidence_refs_check;

-- Registry lifecycle:
--   reserved -> uploaded -> claimed
--                    \-> cleanup -> deleted by service ack
-- A row lock serializes submit against cleanup. Storage objects are removed
-- only through the Storage API; database functions never delete storage.objects.
CREATE TABLE IF NOT EXISTS public.report_evidence_uploads (
  evidence_ref text PRIMARY KEY,
  reporter_id uuid NOT NULL,
  object_name text NOT NULL UNIQUE,
  mime_type text NOT NULL,
  status text NOT NULL DEFAULT 'reserved',
  report_id uuid REFERENCES public.content_reports(id) ON DELETE RESTRICT,
  expires_at timestamptz NOT NULL,
  lease_token uuid,
  lease_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT report_evidence_uploads_status_check
    CHECK (status IN ('reserved', 'uploaded', 'cleanup', 'claimed')),
  CONSTRAINT report_evidence_uploads_mime_check
    CHECK (mime_type IN (
      'image/jpeg',
      'image/png',
      'image/gif',
      'image/webp',
      'image/avif'
    )),
  CONSTRAINT report_evidence_uploads_object_check
    CHECK (object_name = pg_catalog.substr(evidence_ref, 9)),
  CONSTRAINT report_evidence_uploads_lifecycle_check
    CHECK (
      (
        status IN ('reserved', 'uploaded')
        AND report_id IS NULL
        AND lease_token IS NULL
        AND lease_expires_at IS NULL
      ) OR (
        status = 'cleanup'
        AND report_id IS NULL
        AND lease_token IS NOT NULL
        AND lease_expires_at IS NOT NULL
      ) OR (
        status = 'claimed'
        AND report_id IS NOT NULL
        AND lease_token IS NULL
        AND lease_expires_at IS NULL
      )
    )
);

ALTER TABLE public.report_evidence_uploads
  DROP CONSTRAINT IF EXISTS report_evidence_uploads_ref_check;
ALTER TABLE public.report_evidence_uploads
  ADD CONSTRAINT report_evidence_uploads_ref_check
  CHECK (
    public.content_report_evidence_refs_valid(
      reporter_id,
      ARRAY[evidence_ref]::text[]
    )
  )
  NOT VALID;
ALTER TABLE public.report_evidence_uploads
  VALIDATE CONSTRAINT report_evidence_uploads_ref_check;

ALTER TABLE public.report_evidence_uploads OWNER TO postgres;
ALTER TABLE public.report_evidence_uploads ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS report_evidence_uploads_cleanup_idx
  ON public.report_evidence_uploads (
    status,
    expires_at,
    lease_expires_at,
    evidence_ref
  )
  WHERE status <> 'claimed';

DO $revoke_nonowner_registry_table_access$
DECLARE
  v_grantee record;
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
    WHERE relation.oid = 'public.report_evidence_uploads'::regclass
      AND acl_entry.grantee <> relation.relowner
  LOOP
    IF v_grantee.grantee = 0 THEN
      REVOKE ALL PRIVILEGES ON TABLE public.report_evidence_uploads FROM PUBLIC;
    ELSIF v_grantee.rolname IS NOT NULL THEN
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON TABLE public.report_evidence_uploads FROM %I',
        v_grantee.rolname
      );
    END IF;
  END LOOP;
END
$revoke_nonowner_registry_table_access$;

REVOKE ALL PRIVILEGES ON TABLE public.report_evidence_uploads
  FROM PUBLIC, anon, authenticated, service_role;

DO $revoke_registry_column_privileges$
DECLARE
  v_column_list text;
  v_grantee record;
BEGIN
  SELECT pg_catalog.string_agg(
    pg_catalog.format('%I', attribute.attname),
    ', ' ORDER BY attribute.attnum
  )
  INTO v_column_list
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.report_evidence_uploads'::regclass
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;

  FOR v_grantee IN
    SELECT DISTINCT acl_entry.grantee, role_row.rolname
    FROM pg_catalog.pg_attribute AS attribute
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl_entry
    LEFT JOIN pg_catalog.pg_roles AS role_row
      ON role_row.oid = acl_entry.grantee
    WHERE attribute.attrelid = 'public.report_evidence_uploads'::regclass
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND acl_entry.grantee <> (
        SELECT relation.relowner
        FROM pg_catalog.pg_class AS relation
        WHERE relation.oid = 'public.report_evidence_uploads'::regclass
      )
  LOOP
    IF v_grantee.grantee = 0 THEN
      EXECUTE pg_catalog.format(
        'REVOKE SELECT (%1$s), INSERT (%1$s), UPDATE (%1$s), REFERENCES (%1$s) '
          || 'ON TABLE public.report_evidence_uploads FROM PUBLIC',
        v_column_list
      );
    ELSIF v_grantee.rolname IS NOT NULL THEN
      EXECUTE pg_catalog.format(
        'REVOKE SELECT (%1$s), INSERT (%1$s), UPDATE (%1$s), REFERENCES (%1$s) '
          || 'ON TABLE public.report_evidence_uploads FROM %2$I',
        v_column_list,
        v_grantee.rolname
      );
    END IF;
  END LOOP;
END
$revoke_registry_column_privileges$;

DO $drop_registry_policies$
DECLARE
  v_policy_name name;
BEGIN
  FOR v_policy_name IN
    SELECT policy.polname
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.report_evidence_uploads'::regclass
  LOOP
    EXECUTE pg_catalog.format(
      'DROP POLICY %I ON public.report_evidence_uploads',
      v_policy_name
    );
  END LOOP;
END
$drop_registry_policies$;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.report_evidence_uploads
  TO service_role;
CREATE POLICY "Service role manages report evidence uploads"
  ON public.report_evidence_uploads
  AS PERMISSIVE
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

DO $drop_report_evidence_lifecycle_overloads$
DECLARE
  v_signature regprocedure;
BEGIN
  FOR v_signature IN
    SELECT function_row.oid::regprocedure
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_namespace AS function_schema
      ON function_schema.oid = function_row.pronamespace
    WHERE function_schema.nspname = 'public'
      AND function_row.proname = ANY (ARRAY[
        'reserve_report_evidence_upload',
        'finalize_report_evidence_upload',
        'lease_report_evidence_cleanup',
        'ack_report_evidence_cleanup',
        'release_report_evidence_cleanup',
        'lease_stale_report_evidence_cleanup'
      ]::text[])
      AND function_row.prokind = 'f'
  LOOP
    EXECUTE pg_catalog.format('DROP FUNCTION %s', v_signature);
  END LOOP;
END
$drop_report_evidence_lifecycle_overloads$;

CREATE FUNCTION public.reserve_report_evidence_upload(
  p_reporter_id uuid,
  p_extension text,
  p_mime_type text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_evidence_ref text;
  v_object_name text;
  v_expires_at timestamptz;
  v_unclaimed_count integer;
  v_attempt integer;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'service role required';
  END IF;

  IF p_reporter_id IS NULL OR NOT (
    (p_extension = 'jpg' AND p_mime_type = 'image/jpeg')
    OR (p_extension = 'png' AND p_mime_type = 'image/png')
    OR (p_extension = 'gif' AND p_mime_type = 'image/gif')
    OR (p_extension = 'webp' AND p_mime_type = 'image/webp')
    OR (p_extension = 'avif' AND p_mime_type = 'image/avif')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid report evidence type';
  END IF;

  PERFORM 1
  FROM public.user_profiles AS reporter
  WHERE reporter.id = p_reporter_id
    AND reporter.banned_at IS NULL
    AND reporter.deleted_at IS NULL
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'active reporter profile required';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'report-evidence-reserve:' || p_reporter_id::text,
      0
    )
  );

  SELECT pg_catalog.count(*)::integer
  INTO v_unclaimed_count
  FROM public.report_evidence_uploads AS upload_row
  WHERE upload_row.reporter_id = p_reporter_id
    AND upload_row.status <> 'claimed';

  IF v_unclaimed_count >= 8 THEN
    RAISE EXCEPTION USING
      ERRCODE = '54000',
      MESSAGE = 'report evidence unclaimed upload limit reached';
  END IF;

  v_expires_at := pg_catalog.clock_timestamp() + INTERVAL '1 hour';

  FOR v_attempt IN 1..8 LOOP
    v_object_name := pg_catalog.lower(p_reporter_id::text)
      || '/'
      || pg_catalog.substr(
        pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', ''),
        1,
        16
      )
      || '.' || p_extension;
    v_evidence_ref := 'reports/' || v_object_name;

    BEGIN
      INSERT INTO public.report_evidence_uploads (
        evidence_ref,
        reporter_id,
        object_name,
        mime_type,
        status,
        expires_at
      ) VALUES (
        v_evidence_ref,
        p_reporter_id,
        v_object_name,
        p_mime_type,
        'reserved',
        v_expires_at
      );
      RETURN pg_catalog.jsonb_build_object(
        'reserved', true,
        'evidence_ref', v_evidence_ref,
        'object_name', v_object_name,
        'expires_at', v_expires_at
      );
    EXCEPTION WHEN unique_violation THEN
      NULL;
    END;
  END LOOP;

  RAISE EXCEPTION USING
    ERRCODE = '40001',
    MESSAGE = 'could not allocate unique report evidence reference';
END
$function$;

CREATE FUNCTION public.finalize_report_evidence_upload(
  p_reporter_id uuid,
  p_evidence_ref text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_status text;
  v_object_name text;
  v_expires_at timestamptz;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'service role required';
  END IF;
  IF NOT public.content_report_evidence_refs_valid(
    p_reporter_id,
    ARRAY[p_evidence_ref]::text[]
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid report evidence reference';
  END IF;

  SELECT upload_row.status, upload_row.object_name, upload_row.expires_at
  INTO v_status, v_object_name, v_expires_at
  FROM public.report_evidence_uploads AS upload_row
  WHERE upload_row.evidence_ref = p_evidence_ref
    AND upload_row.reporter_id = p_reporter_id
  FOR UPDATE;

  IF NOT FOUND OR v_status NOT IN ('reserved', 'uploaded')
     OR v_expires_at <= pg_catalog.clock_timestamp()
  THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'report evidence reservation unavailable';
  END IF;

  PERFORM 1
  FROM storage.objects AS object_row
  WHERE object_row.bucket_id = 'reports'
    AND object_row.name = v_object_name
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'report evidence object not found';
  END IF;

  UPDATE public.report_evidence_uploads
  SET status = 'uploaded', updated_at = pg_catalog.clock_timestamp()
  WHERE evidence_ref = p_evidence_ref;

  RETURN pg_catalog.jsonb_build_object(
    'finalized', true,
    'evidence_ref', p_evidence_ref,
    'status', 'uploaded',
    'expires_at', v_expires_at
  );
END
$function$;

CREATE FUNCTION public.lease_report_evidence_cleanup(
  p_reporter_id uuid,
  p_evidence_ref text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_status text;
  v_object_name text;
  v_lease_token uuid;
  v_lease_expires_at timestamptz;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'service role required';
  END IF;
  IF NOT public.content_report_evidence_refs_valid(
    p_reporter_id,
    ARRAY[p_evidence_ref]::text[]
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid report evidence reference';
  END IF;

  SELECT
    upload_row.status,
    upload_row.object_name,
    upload_row.lease_token,
    upload_row.lease_expires_at
  INTO v_status, v_object_name, v_lease_token, v_lease_expires_at
  FROM public.report_evidence_uploads AS upload_row
  WHERE upload_row.evidence_ref = p_evidence_ref
    AND upload_row.reporter_id = p_reporter_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('acquired', false, 'reason', 'NOT_FOUND');
  END IF;
  IF v_status = 'claimed' THEN
    RETURN pg_catalog.jsonb_build_object('acquired', false, 'reason', 'CLAIMED');
  END IF;

  IF v_status = 'cleanup'
     AND v_lease_expires_at > pg_catalog.clock_timestamp()
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'acquired', true,
      'evidence_ref', p_evidence_ref,
      'object_name', v_object_name,
      'lease_token', v_lease_token,
      'lease_expires_at', v_lease_expires_at
    );
  END IF;

  v_lease_token := pg_catalog.gen_random_uuid();
  v_lease_expires_at := pg_catalog.clock_timestamp() + INTERVAL '2 minutes';
  UPDATE public.report_evidence_uploads
  SET status = 'cleanup',
      lease_token = v_lease_token,
      lease_expires_at = v_lease_expires_at,
      updated_at = pg_catalog.clock_timestamp()
  WHERE evidence_ref = p_evidence_ref;

  RETURN pg_catalog.jsonb_build_object(
    'acquired', true,
    'evidence_ref', p_evidence_ref,
    'object_name', v_object_name,
    'lease_token', v_lease_token,
    'lease_expires_at', v_lease_expires_at
  );
END
$function$;

CREATE FUNCTION public.ack_report_evidence_cleanup(
  p_reporter_id uuid,
  p_evidence_ref text,
  p_lease_token uuid
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_deleted integer;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'service role required';
  END IF;
  DELETE FROM public.report_evidence_uploads AS upload_row
  WHERE upload_row.evidence_ref = p_evidence_ref
    AND upload_row.reporter_id = p_reporter_id
    AND upload_row.status = 'cleanup'
    AND upload_row.lease_token = p_lease_token;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted = 1;
END
$function$;

CREATE FUNCTION public.release_report_evidence_cleanup(
  p_reporter_id uuid,
  p_evidence_ref text,
  p_lease_token uuid
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_updated integer;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'service role required';
  END IF;
  UPDATE public.report_evidence_uploads AS upload_row
  SET status = 'uploaded',
      expires_at = LEAST(upload_row.expires_at, pg_catalog.clock_timestamp()),
      lease_token = NULL,
      lease_expires_at = NULL,
      updated_at = pg_catalog.clock_timestamp()
  WHERE upload_row.evidence_ref = p_evidence_ref
    AND upload_row.reporter_id = p_reporter_id
    AND upload_row.status = 'cleanup'
    AND upload_row.lease_token = p_lease_token;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated = 1;
END
$function$;

CREATE FUNCTION public.lease_stale_report_evidence_cleanup(
  p_limit integer DEFAULT 50
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_result jsonb;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'service role required';
  END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid cleanup batch limit';
  END IF;

  WITH candidates AS (
    SELECT upload_row.evidence_ref
    FROM public.report_evidence_uploads AS upload_row
    WHERE (
      upload_row.status IN ('reserved', 'uploaded')
      AND upload_row.expires_at <= pg_catalog.clock_timestamp()
    ) OR (
      upload_row.status = 'cleanup'
      AND upload_row.lease_expires_at <= pg_catalog.clock_timestamp()
    )
    ORDER BY
      COALESCE(upload_row.lease_expires_at, upload_row.expires_at),
      upload_row.evidence_ref
    FOR UPDATE SKIP LOCKED
    LIMIT p_limit
  ), leased AS (
    UPDATE public.report_evidence_uploads AS upload_row
    SET status = 'cleanup',
        expires_at = LEAST(
          upload_row.expires_at,
          pg_catalog.clock_timestamp()
        ),
        lease_token = pg_catalog.gen_random_uuid(),
        lease_expires_at = pg_catalog.clock_timestamp() + INTERVAL '2 minutes',
        updated_at = pg_catalog.clock_timestamp()
    FROM candidates
    WHERE upload_row.evidence_ref = candidates.evidence_ref
    RETURNING
      upload_row.evidence_ref,
      upload_row.reporter_id,
      upload_row.object_name,
      upload_row.lease_token,
      upload_row.lease_expires_at
  )
  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'evidence_ref', leased.evidence_ref,
        'reporter_id', leased.reporter_id,
        'object_name', leased.object_name,
        'lease_token', leased.lease_token,
        'lease_expires_at', leased.lease_expires_at
      ) ORDER BY leased.evidence_ref
    ),
    '[]'::jsonb
  )
  INTO v_result
  FROM leased;

  RETURN v_result;
END
$function$;

ALTER FUNCTION public.reserve_report_evidence_upload(uuid, text, text) OWNER TO postgres;
ALTER FUNCTION public.finalize_report_evidence_upload(uuid, text) OWNER TO postgres;
ALTER FUNCTION public.lease_report_evidence_cleanup(uuid, text) OWNER TO postgres;
ALTER FUNCTION public.ack_report_evidence_cleanup(uuid, text, uuid) OWNER TO postgres;
ALTER FUNCTION public.release_report_evidence_cleanup(uuid, text, uuid) OWNER TO postgres;
ALTER FUNCTION public.lease_stale_report_evidence_cleanup(integer) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.reserve_report_evidence_upload(uuid, text, text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.finalize_report_evidence_upload(uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.lease_report_evidence_cleanup(uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.ack_report_evidence_cleanup(uuid, text, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.release_report_evidence_cleanup(uuid, text, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.lease_stale_report_evidence_cleanup(integer)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.reserve_report_evidence_upload(uuid, text, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.finalize_report_evidence_upload(uuid, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.lease_report_evidence_cleanup(uuid, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.ack_report_evidence_cleanup(uuid, text, uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.release_report_evidence_cleanup(uuid, text, uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.lease_stale_report_evidence_cleanup(integer)
  TO service_role;

DO $drop_submit_content_report_overloads$
DECLARE
  v_signature regprocedure;
BEGIN
  FOR v_signature IN
    SELECT function_row.oid::regprocedure
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_namespace AS function_schema
      ON function_schema.oid = function_row.pronamespace
    WHERE function_schema.nspname = 'public'
      AND function_row.proname = 'submit_content_report'
      AND function_row.prokind = 'f'
  LOOP
    EXECUTE pg_catalog.format('DROP FUNCTION %s', v_signature);
  END LOOP;
END
$drop_submit_content_report_overloads$;

CREATE FUNCTION public.submit_content_report(
  p_reporter_id uuid,
  p_content_type text,
  p_content_id uuid,
  p_reason text,
  p_description text DEFAULT NULL,
  p_images text[] DEFAULT ARRAY[]::text[]
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_description text;
  v_image text;
  v_object_name text;
  v_report_id uuid;
  v_created_at timestamptz;
  v_target_author_id uuid;
  v_parent_post_id uuid;
  v_candidate_post_id uuid;
  v_user1_id uuid;
  v_user2_id uuid;
  v_upload_status text;
  v_upload_expires_at timestamptz;
  v_locked_upload_count integer := 0;
  v_claimed_count integer;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'service role required';
  END IF;

  v_description := pg_catalog.btrim(p_description);

  IF p_reporter_id IS NULL
     OR p_content_id IS NULL
     OR p_content_type IS NULL
     OR p_content_type NOT IN ('post', 'comment', 'message', 'user')
     OR p_reason IS NULL
     OR p_reason NOT IN (
       'spam',
       'harassment',
       'inappropriate',
       'misinformation',
       'fraud',
       'other'
     )
     OR v_description IS NULL
     OR pg_catalog.char_length(v_description) NOT BETWEEN 15 AND 1000
     OR NOT public.content_report_evidence_refs_valid(p_reporter_id, p_images)
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'invalid content report input';
  END IF;

  PERFORM 1
  FROM public.user_profiles AS reporter
  WHERE reporter.id = p_reporter_id
    AND reporter.banned_at IS NULL
    AND reporter.deleted_at IS NULL
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'active reporter profile required';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'content-report:'
        || p_reporter_id::text
        || ':' || p_content_type
        || ':' || p_content_id::text,
      0
    )
  );

  SELECT report_row.id, report_row.created_at
  INTO v_report_id, v_created_at
  FROM public.content_reports AS report_row
  WHERE report_row.reporter_id = p_reporter_id
    AND report_row.content_type = p_content_type
    AND report_row.content_id = p_content_id::text
    AND report_row.status = 'pending'
  LIMIT 1;

  IF v_report_id IS NOT NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'created', false,
      'report_id', v_report_id,
      'status', 'pending',
      'reason', 'DUPLICATE_PENDING',
      'content_type', p_content_type,
      'created_at', v_created_at
    );
  END IF;

  CASE p_content_type
    WHEN 'post' THEN
      -- The shared authorization helper acquires every block advisory before
      -- any post row. Never hold the target row and then enter that helper.
      IF NOT public.lock_actor_can_interact_with_post(
        p_content_id,
        p_reporter_id
      ) THEN
        RAISE EXCEPTION USING
          ERRCODE = '42501',
          MESSAGE = 'report target is unavailable';
      END IF;

      SELECT post_row.author_id
      INTO v_target_author_id
      FROM public.posts AS post_row
      WHERE post_row.id = p_content_id
      FOR SHARE;

      IF NOT FOUND OR v_target_author_id = p_reporter_id THEN
        RAISE EXCEPTION USING
          ERRCODE = '42501',
          MESSAGE = 'report target is unavailable';
      END IF;

    WHEN 'comment' THEN
      -- Discover the parent without locking the comment. The authorization
      -- helper first takes block advisory locks and locks the parent post;
      -- only then may this transaction lock and revalidate the comment row.
      SELECT comment_row.post_id
      INTO v_candidate_post_id
      FROM public.comments AS comment_row
      WHERE comment_row.id = p_content_id
        AND comment_row.deleted_at IS NULL;

      IF NOT FOUND OR NOT public.lock_actor_can_interact_with_post(
        v_candidate_post_id,
        p_reporter_id
      ) THEN
        RAISE EXCEPTION USING
          ERRCODE = '42501',
          MESSAGE = 'report target is unavailable';
      END IF;

      SELECT comment_row.user_id, comment_row.post_id
      INTO v_target_author_id, v_parent_post_id
      FROM public.comments AS comment_row
      WHERE comment_row.id = p_content_id
        AND comment_row.deleted_at IS NULL
      FOR SHARE;

      IF NOT FOUND
         OR v_target_author_id = p_reporter_id
         OR v_parent_post_id IS DISTINCT FROM v_candidate_post_id
      THEN
        RAISE EXCEPTION USING
          ERRCODE = '42501',
          MESSAGE = 'report target is unavailable';
      END IF;

    WHEN 'user' THEN
      IF p_content_id = p_reporter_id THEN
        RAISE EXCEPTION USING
          ERRCODE = '22023',
          MESSAGE = 'cannot report own profile';
      END IF;

      PERFORM 1
      FROM public.user_profiles AS target_profile
      WHERE target_profile.id = p_content_id
        AND target_profile.deleted_at IS NULL
      FOR SHARE;

      IF NOT FOUND THEN
        RAISE EXCEPTION USING
          ERRCODE = '42501',
          MESSAGE = 'report target is unavailable';
      END IF;

    WHEN 'message' THEN
      SELECT conversation.user1_id, conversation.user2_id
      INTO v_user1_id, v_user2_id
      FROM public.conversations AS conversation
      WHERE conversation.id = p_content_id
      FOR SHARE;

      IF NOT FOUND OR p_reporter_id NOT IN (v_user1_id, v_user2_id) THEN
        RAISE EXCEPTION USING
          ERRCODE = '42501',
          MESSAGE = 'report target is unavailable';
      END IF;
  END CASE;

  -- Lock the complete registry set in canonical evidence_ref order, independent
  -- of caller array order. Cleanup takes the same row lock, so submit/cleanup
  -- still have one winner, while [A,B] and [B,A] submissions cannot deadlock.
  FOR v_image, v_upload_status, v_object_name, v_upload_expires_at IN
    SELECT
      upload_row.evidence_ref,
      upload_row.status,
      upload_row.object_name,
      upload_row.expires_at
    FROM public.report_evidence_uploads AS upload_row
    WHERE upload_row.reporter_id = p_reporter_id
      AND upload_row.evidence_ref = ANY (p_images)
    ORDER BY upload_row.evidence_ref
    FOR UPDATE
  LOOP
    v_locked_upload_count := v_locked_upload_count + 1;

    IF v_upload_status <> 'uploaded'
       OR v_upload_expires_at <= pg_catalog.clock_timestamp()
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '22023',
        MESSAGE = 'report evidence upload is unavailable';
    END IF;

    PERFORM 1
    FROM storage.objects AS object_row
    WHERE object_row.bucket_id = 'reports'
      AND object_row.name = v_object_name
    FOR SHARE;

    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = '22023',
      MESSAGE = 'report evidence object not found';
    END IF;
  END LOOP;

  IF v_locked_upload_count <> pg_catalog.cardinality(p_images) THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'report evidence upload is unavailable';
  END IF;

  BEGIN
    INSERT INTO public.content_reports (
      reporter_id,
      content_type,
      content_id,
      reason,
      description,
      images,
      status
    ) VALUES (
      p_reporter_id,
      p_content_type,
      p_content_id::text,
      p_reason,
      v_description,
      p_images,
      'pending'
    )
    RETURNING id, created_at INTO v_report_id, v_created_at;
  EXCEPTION
    WHEN unique_violation THEN
      SELECT report_row.id, report_row.created_at
      INTO v_report_id, v_created_at
      FROM public.content_reports AS report_row
      WHERE report_row.reporter_id = p_reporter_id
        AND report_row.content_type = p_content_type
        AND report_row.content_id = p_content_id::text
        AND report_row.status = 'pending'
      LIMIT 1;

      IF v_report_id IS NULL THEN
        RAISE;
      END IF;

      RETURN pg_catalog.jsonb_build_object(
        'created', false,
        'report_id', v_report_id,
        'status', 'pending',
        'reason', 'DUPLICATE_PENDING',
        'content_type', p_content_type,
        'created_at', v_created_at
      );
  END;

  UPDATE public.report_evidence_uploads AS upload_row
  SET status = 'claimed',
      report_id = v_report_id,
      lease_token = NULL,
      lease_expires_at = NULL,
      updated_at = pg_catalog.clock_timestamp()
  WHERE upload_row.reporter_id = p_reporter_id
    AND upload_row.evidence_ref = ANY (p_images)
    AND upload_row.status = 'uploaded'
    AND upload_row.report_id IS NULL;
  GET DIAGNOSTICS v_claimed_count = ROW_COUNT;

  IF v_claimed_count <> pg_catalog.cardinality(p_images) THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'report evidence claim race detected';
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'created', true,
    'report_id', v_report_id,
    'status', 'pending',
    'reason', p_reason,
    'content_type', p_content_type,
    'created_at', v_created_at
  );
END
$function$;

ALTER FUNCTION public.submit_content_report(
  uuid,
  text,
  uuid,
  text,
  text,
  text[]
) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.submit_content_report(
  uuid,
  text,
  uuid,
  text,
  text,
  text[]
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.submit_content_report(
  uuid,
  text,
  uuid,
  text,
  text,
  text[]
) TO service_role;

DO $postflight$
DECLARE
  v_submit regprocedure :=
    'public.submit_content_report(uuid,text,uuid,text,text,text[])'::regprocedure;
  v_validator regprocedure :=
    'public.content_report_evidence_refs_valid(uuid,text[])'::regprocedure;
  v_service_role_oid oid := (
    SELECT role_row.oid FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'service_role'
  );
  v_postgres_role_oid oid := (
    SELECT role_row.oid FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'postgres'
  );
  v_registry regclass := 'public.report_evidence_uploads'::regclass;
  v_lifecycle_function regprocedure;
  v_expected_check text;
  v_relation_name text;
  v_relation regclass;
BEGIN
  IF NOT (
    SELECT relation.relrowsecurity
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = 'public.content_reports'::regclass
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index AS index_metadata
    WHERE index_metadata.indexrelid =
      'public.uniq_content_reports_pending_reporter_content'::regclass
      AND index_metadata.indrelid = 'public.content_reports'::regclass
      AND index_metadata.indisunique
      AND index_metadata.indisvalid
      AND index_metadata.indisready
      AND index_metadata.indexprs IS NULL
      AND index_metadata.indnkeyatts = 3
      AND index_metadata.indnatts = 3
      AND (
        SELECT pg_catalog.array_agg(
          attribute.attname ORDER BY key_column.ordinality
        )
        FROM pg_catalog.unnest(index_metadata.indkey)
          WITH ORDINALITY AS key_column(attnum, ordinality)
        JOIN pg_catalog.pg_attribute AS attribute
          ON attribute.attrelid = index_metadata.indrelid
         AND attribute.attnum = key_column.attnum
      ) = ARRAY['reporter_id', 'content_type', 'content_id']::name[]
      AND pg_catalog.pg_get_expr(
        index_metadata.indpred,
        index_metadata.indrelid
      ) = '(status = ''pending''::text)'
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        relation.relacl,
        pg_catalog.acldefault('r', relation.relowner)
      )
    ) AS acl_entry
    WHERE relation.oid = 'public.content_reports'::regclass
      AND acl_entry.grantee NOT IN (relation.relowner, v_service_role_oid)
  ) OR (
    SELECT pg_catalog.array_agg(
      DISTINCT acl_entry.privilege_type ORDER BY acl_entry.privilege_type
    )
    FROM pg_catalog.pg_class AS relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        relation.relacl,
        pg_catalog.acldefault('r', relation.relowner)
      )
    ) AS acl_entry
    WHERE relation.oid = 'public.content_reports'::regclass
      AND acl_entry.grantee = v_service_role_oid
  ) IS DISTINCT FROM ARRAY['DELETE', 'INSERT', 'SELECT', 'UPDATE']::text[] OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    JOIN pg_catalog.pg_class AS relation
      ON relation.oid = attribute.attrelid
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl_entry
    WHERE attribute.attrelid = 'public.content_reports'::regclass
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND acl_entry.grantee <> relation.relowner
  ) OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.content_reports'::regclass
  ) <> 1 OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.content_reports'::regclass
      AND policy.polname = 'Service role manages content reports'
      AND policy.polpermissive
      AND policy.polcmd = '*'
      AND policy.polroles = ARRAY[v_service_role_oid]::oid[]
      AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid) = 'true'
      AND pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid) = 'true'
  ) THEN
    RAISE EXCEPTION
      '112300 content report dependency changed during private evidence rollout';
  END IF;

  IF (
    SELECT pg_catalog.pg_get_expr(
      column_default.adbin,
      column_default.adrelid,
      true
    )
    FROM pg_catalog.pg_attribute AS attribute
    JOIN pg_catalog.pg_attrdef AS column_default
      ON column_default.adrelid = attribute.attrelid
     AND column_default.adnum = attribute.attnum
    WHERE attribute.attrelid = 'public.content_reports'::regclass
      AND attribute.attname = 'status'
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  ) IS DISTINCT FROM '''pending''::text' THEN
    RAISE EXCEPTION
      'content_reports.status default changed during private evidence rollout';
  END IF;

  FOREACH v_expected_check IN ARRAY ARRAY[
    'content_type = ANY (ARRAY[''post''::text, ''comment''::text, ''message''::text, ''user''::text])',
    'reason = ANY (ARRAY[''spam''::text, ''harassment''::text, ''inappropriate''::text, ''misinformation''::text, ''fraud''::text, ''other''::text])',
    'status = ANY (ARRAY[''pending''::text, ''resolved''::text, ''dismissed''::text])'
  ]::text[]
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_constraint AS constraint_row
      WHERE constraint_row.conrelid = 'public.content_reports'::regclass
        AND constraint_row.contype = 'c'
        AND constraint_row.convalidated
        AND NOT constraint_row.connoinherit
        AND pg_catalog.pg_get_expr(
          constraint_row.conbin,
          constraint_row.conrelid,
          true
        ) = v_expected_check
    ) THEN
      RAISE EXCEPTION
        'content_reports canonical check changed during private evidence rollout: %',
        v_expected_check;
    END IF;
  END LOOP;

  FOREACH v_relation_name IN ARRAY ARRAY[
    'content_reports',
    'posts',
    'comments',
    'conversations',
    'user_profiles'
  ]::text[]
  LOOP
    v_relation := pg_catalog.to_regclass(
      pg_catalog.format('public.%I', v_relation_name)
    );
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_index AS index_metadata
      WHERE index_metadata.indrelid = v_relation
        AND index_metadata.indisunique
        AND index_metadata.indisvalid
        AND index_metadata.indisready
        AND index_metadata.indimmediate
        AND NOT index_metadata.indisexclusion
        AND index_metadata.indpred IS NULL
        AND index_metadata.indexprs IS NULL
        AND index_metadata.indnkeyatts = 1
        AND index_metadata.indnatts = 1
        AND (
          SELECT attribute.attname
          FROM pg_catalog.unnest(index_metadata.indkey)
            WITH ORDINALITY AS key_column(attnum, ordinality)
          JOIN pg_catalog.pg_attribute AS attribute
            ON attribute.attrelid = index_metadata.indrelid
           AND attribute.attnum = key_column.attnum
          WHERE key_column.ordinality = 1
        ) = 'id'
    ) THEN
      RAISE EXCEPTION
        'public.% unique (id) dependency changed during private evidence rollout',
        v_relation_name;
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = 'public.content_reports'::regclass
      AND attribute.attname = 'images'
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND attribute.attnotnull
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    JOIN pg_catalog.pg_attrdef AS column_default
      ON column_default.adrelid = attribute.attrelid
     AND column_default.adnum = attribute.attnum
    WHERE attribute.attrelid = 'public.content_reports'::regclass
      AND attribute.attname = 'images'
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  ) THEN
    RAISE EXCEPTION 'content_reports.images null/default contract is invalid';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM storage.buckets AS bucket
    WHERE bucket.id = 'reports'
      AND bucket.name = 'reports'
      AND bucket.public IS false
      AND bucket.file_size_limit = 2097152
      AND bucket.allowed_mime_types = ARRAY[
        'image/jpeg',
        'image/png',
        'image/gif',
        'image/webp',
        'image/avif'
      ]::text[]
  ) THEN
    RAISE EXCEPTION 'private reports bucket contract is invalid';
  END IF;

  IF NOT (
    SELECT relation.relrowsecurity
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = 'storage.objects'::regclass
  ) THEN
    RAISE EXCEPTION 'RLS is not enabled on storage.objects';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'storage.objects'::regclass
      AND policy.polname = 'Non-service roles cannot access report evidence'
      AND NOT policy.polpermissive
      AND policy.polcmd = '*'
      AND policy.polroles = ARRAY[0::oid]::oid[]
      AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid) =
        '((bucket_id <> ''reports''::text) OR (CURRENT_USER = ''service_role''::name))'
      AND pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid) =
        '((bucket_id <> ''reports''::text) OR (CURRENT_USER = ''service_role''::name))'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'storage.objects'::regclass
      AND policy.polname = 'Service role manages report evidence'
      AND policy.polpermissive
      AND policy.polcmd = '*'
      AND policy.polroles = ARRAY[v_service_role_oid]::oid[]
      AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid) =
        '(bucket_id = ''reports''::text)'
      AND pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid) =
        '(bucket_id = ''reports''::text)'
  ) THEN
    RAISE EXCEPTION 'private report evidence RLS policy contract is invalid';
  END IF;

  IF (
    SELECT relation.relowner = v_postgres_role_oid
      AND relation.relrowsecurity
      AND relation.relkind = 'r'
      AND relation.relpersistence = 'p'
      AND NOT relation.relispartition
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = v_registry
  ) IS NOT TRUE OR EXISTS (
    SELECT 1
    FROM (
      VALUES
        (1, 'evidence_ref', 'text', true),
        (2, 'reporter_id', 'uuid', true),
        (3, 'object_name', 'text', true),
        (4, 'mime_type', 'text', true),
        (5, 'status', 'text', true),
        (6, 'report_id', 'uuid', false),
        (7, 'expires_at', 'timestamp with time zone', true),
        (8, 'lease_token', 'uuid', false),
        (9, 'lease_expires_at', 'timestamp with time zone', false),
        (10, 'created_at', 'timestamp with time zone', true),
        (11, 'updated_at', 'timestamp with time zone', true)
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
       OR attribute.attgenerated <> ''
       OR attribute.attidentity <> ''
  ) OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = v_registry
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  ) <> 11 OR (
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
  ) IS DISTINCT FROM 'now()' OR (
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
  ) IS DISTINCT FROM 'now()' OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    JOIN pg_catalog.pg_attrdef AS column_default
      ON column_default.adrelid = attribute.attrelid
     AND column_default.adnum = attribute.attnum
    WHERE attribute.attrelid = v_registry
      AND attribute.attname NOT IN ('status', 'created_at', 'updated_at')
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  ) OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = v_registry
  ) <> 8 OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    JOIN pg_catalog.pg_index AS index_metadata
      ON index_metadata.indexrelid = constraint_row.conindid
    WHERE constraint_row.conrelid = v_registry
      AND constraint_row.conname = 'report_evidence_uploads_pkey'
      AND constraint_row.contype = 'p'
      AND constraint_row.conkey = ARRAY[1]::smallint[]
      AND constraint_row.convalidated
      AND NOT constraint_row.condeferrable
      AND NOT constraint_row.condeferred
      AND index_metadata.indrelid = v_registry
      AND index_metadata.indisprimary
      AND index_metadata.indisunique
      AND index_metadata.indisvalid
      AND index_metadata.indisready
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    JOIN pg_catalog.pg_index AS index_metadata
      ON index_metadata.indexrelid = constraint_row.conindid
    WHERE constraint_row.conrelid = v_registry
      AND constraint_row.conname = 'report_evidence_uploads_object_name_key'
      AND constraint_row.contype = 'u'
      AND constraint_row.conkey = ARRAY[3]::smallint[]
      AND constraint_row.convalidated
      AND NOT constraint_row.condeferrable
      AND NOT constraint_row.condeferred
      AND index_metadata.indrelid = v_registry
      AND NOT index_metadata.indisprimary
      AND index_metadata.indisunique
      AND index_metadata.indisvalid
      AND index_metadata.indisready
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = v_registry
      AND constraint_row.conname = 'report_evidence_uploads_report_id_fkey'
      AND constraint_row.contype = 'f'
      AND constraint_row.conkey = ARRAY[6]::smallint[]
      AND constraint_row.confrelid = 'public.content_reports'::regclass
      AND constraint_row.confkey = ARRAY[(
        SELECT attribute.attnum
        FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid = 'public.content_reports'::regclass
          AND attribute.attname = 'id'
          AND attribute.attnum > 0
          AND NOT attribute.attisdropped
      )]::smallint[]
      AND constraint_row.confupdtype = 'a'
      AND constraint_row.confdeltype = 'r'
      AND constraint_row.confmatchtype = 's'
      AND constraint_row.convalidated
      AND NOT constraint_row.condeferrable
      AND NOT constraint_row.condeferred
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = v_registry
      AND constraint_row.conname = 'report_evidence_uploads_status_check'
      AND constraint_row.contype = 'c'
      AND constraint_row.convalidated
      AND NOT constraint_row.connoinherit
      AND pg_catalog.pg_get_expr(
        constraint_row.conbin,
        constraint_row.conrelid,
        true
      ) = 'status = ANY (ARRAY[''reserved''::text, ''uploaded''::text, ''cleanup''::text, ''claimed''::text])'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = v_registry
      AND constraint_row.conname = 'report_evidence_uploads_mime_check'
      AND constraint_row.contype = 'c'
      AND constraint_row.convalidated
      AND NOT constraint_row.connoinherit
      AND pg_catalog.pg_get_expr(
        constraint_row.conbin,
        constraint_row.conrelid,
        true
      ) = 'mime_type = ANY (ARRAY[''image/jpeg''::text, ''image/png''::text, ''image/gif''::text, ''image/webp''::text, ''image/avif''::text])'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = v_registry
      AND constraint_row.conname = 'report_evidence_uploads_ref_check'
      AND constraint_row.contype = 'c'
      AND constraint_row.convalidated
      AND NOT constraint_row.connoinherit
      AND pg_catalog.pg_get_expr(
        constraint_row.conbin,
        constraint_row.conrelid,
        true
      ) = 'content_report_evidence_refs_valid(reporter_id, ARRAY[evidence_ref])'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = v_registry
      AND constraint_row.conname = 'report_evidence_uploads_object_check'
      AND constraint_row.contype = 'c'
      AND constraint_row.convalidated
      AND NOT constraint_row.connoinherit
      AND pg_catalog.pg_get_expr(
        constraint_row.conbin,
        constraint_row.conrelid,
        true
      ) = 'object_name = substr(evidence_ref, 9)'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = v_registry
      AND constraint_row.conname = 'report_evidence_uploads_lifecycle_check'
      AND constraint_row.contype = 'c'
      AND constraint_row.convalidated
      AND NOT constraint_row.connoinherit
      AND pg_catalog.pg_get_expr(
        constraint_row.conbin,
        constraint_row.conrelid,
        true
      ) = '(status = ANY (ARRAY[''reserved''::text, ''uploaded''::text])) AND report_id IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL OR status = ''cleanup''::text AND report_id IS NULL AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL OR status = ''claimed''::text AND report_id IS NOT NULL AND lease_token IS NULL AND lease_expires_at IS NULL'
  ) THEN
    RAISE EXCEPTION 'report evidence upload registry schema contract is invalid';
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
    WHERE relation.oid = v_registry
      AND acl_entry.grantee NOT IN (relation.relowner, v_service_role_oid)
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(relation.relacl) AS acl_entry
    WHERE relation.oid = v_registry
      AND acl_entry.grantee = v_service_role_oid
      AND acl_entry.is_grantable
  ) OR (
    SELECT pg_catalog.array_agg(
      DISTINCT acl_entry.privilege_type ORDER BY acl_entry.privilege_type
    )
    FROM pg_catalog.pg_class AS relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        relation.relacl,
        pg_catalog.acldefault('r', relation.relowner)
      )
    ) AS acl_entry
    WHERE relation.oid = v_registry
      AND acl_entry.grantee = v_service_role_oid
  ) IS DISTINCT FROM ARRAY['DELETE', 'INSERT', 'SELECT', 'UPDATE']::text[] OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    JOIN pg_catalog.pg_class AS relation
      ON relation.oid = attribute.attrelid
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl_entry
    WHERE attribute.attrelid = v_registry
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND acl_entry.grantee <> relation.relowner
  ) OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = v_registry
  ) <> 1 OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = v_registry
      AND policy.polname = 'Service role manages report evidence uploads'
      AND policy.polpermissive
      AND policy.polcmd = '*'
      AND policy.polroles = ARRAY[v_service_role_oid]::oid[]
      AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid) = 'true'
      AND pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid) = 'true'
  ) THEN
    RAISE EXCEPTION 'report evidence upload registry ACL/RLS contract is invalid';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index AS index_metadata
    WHERE index_metadata.indexrelid =
      'public.report_evidence_uploads_cleanup_idx'::regclass
      AND index_metadata.indrelid = v_registry
      AND index_metadata.indisvalid
      AND index_metadata.indisready
      AND index_metadata.indnkeyatts = 4
      AND (
        SELECT pg_catalog.array_agg(
          attribute.attname ORDER BY key_column.ordinality
        )
        FROM pg_catalog.unnest(index_metadata.indkey)
          WITH ORDINALITY AS key_column(attnum, ordinality)
        JOIN pg_catalog.pg_attribute AS attribute
          ON attribute.attrelid = index_metadata.indrelid
         AND attribute.attnum = key_column.attnum
      ) = ARRAY[
        'status', 'expires_at', 'lease_expires_at', 'evidence_ref'
      ]::name[]
      AND pg_catalog.pg_get_expr(
        index_metadata.indpred,
        index_metadata.indrelid
      ) = '(status <> ''claimed''::text)'
  ) THEN
    RAISE EXCEPTION 'report evidence cleanup index contract is invalid';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_namespace AS function_schema
      ON function_schema.oid = function_row.pronamespace
    WHERE function_schema.nspname = 'public'
      AND function_row.proname = 'content_report_evidence_refs_valid'
      AND function_row.prokind = 'f'
  ) <> 1 OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_validator
      AND NOT function_row.prosecdef
      AND function_row.proowner = v_postgres_role_oid
      AND function_row.provolatile = 'i'
      AND function_row.prorettype = 'boolean'::regtype
      AND function_row.proconfig =
        ARRAY['search_path=pg_catalog, pg_temp']::text[]
  ) THEN
    RAISE EXCEPTION 'report evidence validator function contract is invalid';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.content_reports'::regclass
      AND constraint_row.conname = 'content_reports_private_evidence_refs_check'
      AND constraint_row.contype = 'c'
      AND constraint_row.convalidated
      AND pg_catalog.pg_get_expr(
        constraint_row.conbin,
        constraint_row.conrelid,
        true
      ) = 'content_report_evidence_refs_valid(reporter_id, images)'
  ) THEN
    RAISE EXCEPTION 'content report evidence check constraint is invalid';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_namespace AS function_schema
      ON function_schema.oid = function_row.pronamespace
    WHERE function_schema.nspname = 'public'
      AND function_row.proname = 'submit_content_report'
      AND function_row.prokind = 'f'
  ) <> 1 OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_submit
      AND function_row.prosecdef
      AND function_row.proowner = v_postgres_role_oid
      AND function_row.provolatile = 'v'
      AND function_row.prorettype = 'jsonb'::regtype
      AND function_row.pronargdefaults = 2
      AND function_row.proconfig =
        ARRAY['search_path=pg_catalog, pg_temp']::text[]
  ) THEN
    RAISE EXCEPTION 'submit_content_report function contract is invalid';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_namespace AS function_schema
      ON function_schema.oid = function_row.pronamespace
    WHERE function_schema.nspname = 'public'
      AND function_row.proname = ANY (ARRAY[
        'reserve_report_evidence_upload',
        'finalize_report_evidence_upload',
        'lease_report_evidence_cleanup',
        'ack_report_evidence_cleanup',
        'release_report_evidence_cleanup',
        'lease_stale_report_evidence_cleanup'
      ]::text[])
      AND function_row.prokind = 'f'
  ) <> 6 THEN
    RAISE EXCEPTION 'report evidence lifecycle function overload drift remains';
  END IF;

  FOREACH v_lifecycle_function IN ARRAY ARRAY[
    'public.reserve_report_evidence_upload(uuid,text,text)'::regprocedure,
    'public.finalize_report_evidence_upload(uuid,text)'::regprocedure,
    'public.lease_report_evidence_cleanup(uuid,text)'::regprocedure,
    'public.ack_report_evidence_cleanup(uuid,text,uuid)'::regprocedure,
    'public.release_report_evidence_cleanup(uuid,text,uuid)'::regprocedure,
    'public.lease_stale_report_evidence_cleanup(integer)'::regprocedure
  ]::regprocedure[]
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS function_row
      WHERE function_row.oid = v_lifecycle_function
        AND function_row.prosecdef
        AND function_row.proowner = v_postgres_role_oid
        AND function_row.provolatile = 'v'
        AND function_row.proconfig =
          ARRAY['search_path=pg_catalog, pg_temp']::text[]
    ) OR pg_catalog.has_function_privilege(
      'anon', v_lifecycle_function, 'EXECUTE'
    ) OR pg_catalog.has_function_privilege(
      'authenticated', v_lifecycle_function, 'EXECUTE'
    ) OR NOT pg_catalog.has_function_privilege(
      'service_role', v_lifecycle_function, 'EXECUTE'
    ) OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS function_row
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          function_row.proacl,
          pg_catalog.acldefault('f', function_row.proowner)
        )
      ) AS acl_entry
      WHERE function_row.oid = v_lifecycle_function
        AND acl_entry.grantee NOT IN (function_row.proowner, v_service_role_oid)
    ) OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS function_row
      CROSS JOIN LATERAL pg_catalog.aclexplode(function_row.proacl) AS acl_entry
      WHERE function_row.oid = v_lifecycle_function
        AND acl_entry.grantee = v_service_role_oid
        AND (
          acl_entry.privilege_type <> 'EXECUTE'
          OR acl_entry.is_grantable
        )
    ) THEN
      RAISE EXCEPTION
        'report evidence lifecycle function contract is invalid: %',
        v_lifecycle_function;
    END IF;
  END LOOP;

  IF pg_catalog.has_function_privilege('anon', v_submit, 'EXECUTE')
     OR pg_catalog.has_function_privilege('authenticated', v_submit, 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege('service_role', v_submit, 'EXECUTE')
     OR pg_catalog.has_function_privilege('anon', v_validator, 'EXECUTE')
     OR pg_catalog.has_function_privilege('authenticated', v_validator, 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege('service_role', v_validator, 'EXECUTE')
  THEN
    RAISE EXCEPTION 'private report evidence function ACL is invalid';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        function_row.proacl,
        pg_catalog.acldefault('f', function_row.proowner)
      )
    ) AS acl_entry
    WHERE function_row.oid IN (v_submit::oid, v_validator::oid)
      AND acl_entry.grantee NOT IN (function_row.proowner, v_service_role_oid)
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(function_row.proacl) AS acl_entry
    WHERE function_row.oid IN (v_submit::oid, v_validator::oid)
      AND acl_entry.grantee = v_service_role_oid
      AND (
        acl_entry.privilege_type <> 'EXECUTE'
        OR acl_entry.is_grantable
      )
  ) THEN
    RAISE EXCEPTION
      'arbitrary or grantable private report evidence function ACL remains';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.content_reports AS report_row
    CROSS JOIN LATERAL pg_catalog.unnest(report_row.images) AS evidence(ref)
    WHERE NOT EXISTS (
      SELECT 1
      FROM storage.objects AS object_row
      WHERE object_row.bucket_id = 'reports'
        AND object_row.name = pg_catalog.substr(evidence.ref, 9)
    )
  ) THEN
    RAISE EXCEPTION 'a stored report references missing private evidence';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.content_reports AS report_row
    CROSS JOIN LATERAL pg_catalog.unnest(report_row.images) AS evidence(ref)
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.report_evidence_uploads AS upload_row
      WHERE upload_row.evidence_ref = evidence.ref
        AND upload_row.reporter_id = report_row.reporter_id
        AND upload_row.status = 'claimed'
        AND upload_row.report_id = report_row.id
    )
  ) OR EXISTS (
    SELECT 1
    FROM public.report_evidence_uploads AS upload_row
    WHERE upload_row.status = 'claimed'
      AND NOT EXISTS (
        SELECT 1
        FROM public.content_reports AS report_row
        WHERE report_row.id = upload_row.report_id
          AND report_row.reporter_id = upload_row.reporter_id
          AND upload_row.evidence_ref = ANY (report_row.images)
      )
  ) THEN
    RAISE EXCEPTION 'report evidence claim linkage is inconsistent';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
