-- Make every moderation-queue decision one database transaction. The previous
-- application sequence committed content/user mutations before attempting to
-- write content_reports.status = 'actioned', even though the canonical status
-- CHECK permits only pending/resolved/dismissed. That left sanctions and hidden
-- content committed while the request returned 500 and reports stayed pending.
--
-- This migration deliberately does not restore report-driven auto hiding. The
-- B2C report client has always used /api/reports, while the retired singular
-- /api/report endpoint was the only writer of the legacy Auto-hidden marker.
-- submit_content_report is replaced in the same batch so report creation and
-- moderation take one target-scoped advisory lock before any profile/content
-- row lock. A moderation snapshot therefore cannot miss a concurrently
-- committed report for the same target.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('atomic-report-moderation-queue:v1', 0)
);

DO $preflight$
DECLARE
  v_relation_name text;
  v_relation pg_catalog.regclass;
  v_invalid_columns text[];
  v_expected_status_check text :=
    'status = ANY (ARRAY[''pending''::text, ''resolved''::text, ''dismissed''::text])';
  v_moderation_function pg_catalog.regprocedure := pg_catalog.to_regprocedure(
    'public.moderate_report_queue_atomic(uuid,text,uuid,text)'
  );
  v_submit_function pg_catalog.regprocedure := pg_catalog.to_regprocedure(
    'public.submit_content_report(uuid,text,uuid,text,text,text[])'
  );
  v_validator_function pg_catalog.regprocedure := pg_catalog.to_regprocedure(
    'public.content_report_evidence_refs_valid(uuid,text[])'
  );
  v_interaction_function pg_catalog.regprocedure := pg_catalog.to_regprocedure(
    'public.lock_actor_can_interact_with_post(uuid,uuid)'
  );
  v_postgres_oid oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'postgres'
  );
  v_service_role_oid oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'service_role'
  );
  v_plpgsql_oid oid := (
    SELECT language_row.oid
    FROM pg_catalog.pg_language AS language_row
    WHERE language_row.lanname = 'plpgsql'
  );
  v_sql_oid oid := (
    SELECT language_row.oid
    FROM pg_catalog.pg_language AS language_row
    WHERE language_row.lanname = 'sql'
  );
  v_submit_source text;
  v_moderation_source text;
BEGIN
  FOREACH v_relation_name IN ARRAY ARRAY[
    'content_reports',
    'posts',
    'comments',
    'conversations',
    'user_profiles',
    'report_evidence_uploads',
    'user_strikes',
    'admin_logs'
  ]::text[]
  LOOP
    v_relation := pg_catalog.to_regclass(
      pg_catalog.format('public.%I', v_relation_name)
    );

    IF v_relation IS NULL OR (
      SELECT relation.relkind = 'r'
        AND relation.relpersistence = 'p'
        AND NOT relation.relispartition
      FROM pg_catalog.pg_class AS relation
      WHERE relation.oid = v_relation
    ) IS NOT TRUE THEN
      RAISE EXCEPTION
        'public.% must be an ordinary permanent non-partition table',
        v_relation_name;
    END IF;

    IF EXISTS (
      SELECT 1
      FROM pg_catalog.pg_inherits AS inheritance
      WHERE inheritance.inhrelid = v_relation
         OR inheritance.inhparent = v_relation
    ) OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_rewrite AS rewrite_rule
      WHERE rewrite_rule.ev_class = v_relation
    ) THEN
      RAISE EXCEPTION
        'public.% must not participate in inheritance or rewrite rules',
        v_relation_name;
    END IF;
  END LOOP;

  v_relation := pg_catalog.to_regclass('auth.users');
  IF v_relation IS NULL OR (
    SELECT relation.relkind = 'r'
      AND relation.relpersistence = 'p'
      AND NOT relation.relispartition
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = v_relation
  ) IS NOT TRUE OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_inherits AS inheritance
    WHERE inheritance.inhrelid = v_relation
       OR inheritance.inhparent = v_relation
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_rewrite AS rewrite_rule
    WHERE rewrite_rule.ev_class = v_relation
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = v_relation
      AND attribute.attname = 'id'
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND attribute.atttypid = 'uuid'::pg_catalog.regtype
      AND attribute.attnotnull
      AND attribute.attgenerated = ''
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index AS index_metadata
    WHERE index_metadata.indrelid = v_relation
      AND index_metadata.indisunique
      AND index_metadata.indisvalid
      AND index_metadata.indisready
      AND index_metadata.indimmediate
      AND index_metadata.indpred IS NULL
      AND index_metadata.indexprs IS NULL
      AND index_metadata.indnkeyatts = 1
      AND index_metadata.indnatts = 1
      AND index_metadata.indkey[0] = (
        SELECT attribute.attnum
        FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid = v_relation
          AND attribute.attname = 'id'
      )
  ) THEN
    RAISE EXCEPTION 'auth.users identity authority is incompatible';
  END IF;

  IF pg_catalog.to_regclass('storage.objects') IS NULL OR EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('bucket_id', 'text'),
        ('name', 'text')
    ) AS required_column(column_name, type_name)
    LEFT JOIN pg_catalog.pg_attribute AS attribute
      ON attribute.attrelid = pg_catalog.to_regclass('storage.objects')
     AND attribute.attname = required_column.column_name
     AND attribute.attnum > 0
     AND NOT attribute.attisdropped
    WHERE attribute.attname IS NULL
       OR pg_catalog.format_type(attribute.atttypid, attribute.atttypmod)
            <> required_column.type_name
  ) THEN
    RAISE EXCEPTION 'storage.objects(bucket_id text, name text) must exist';
  END IF;

  IF pg_catalog.to_regprocedure('auth.role()') IS NULL OR (
    SELECT function_row.prorettype
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = pg_catalog.to_regprocedure('auth.role()')
  ) <> 'text'::pg_catalog.regtype THEN
    RAISE EXCEPTION 'auth.role() returning text must exist';
  END IF;

  IF pg_catalog.to_regprocedure(
    'public.moderate_comment(uuid,uuid,text,text)'
  ) IS NULL THEN
    RAISE EXCEPTION 'canonical public.moderate_comment RPC must exist';
  END IF;

  IF v_service_role_oid IS NULL
     OR v_postgres_oid IS NULL
     OR v_plpgsql_oid IS NULL
     OR v_sql_oid IS NULL
  THEN
    RAISE EXCEPTION 'service_role, postgres, and plpgsql must exist';
  END IF;

  SELECT pg_catalog.array_agg(
    pg_catalog.format(
      'public.%I.%I expected %s%s',
      required_column.table_name,
      required_column.column_name,
      required_column.type_name,
      CASE WHEN required_column.is_not_null THEN ' NOT NULL' ELSE '' END
    )
    ORDER BY required_column.table_name, required_column.ordinality
  )
  INTO v_invalid_columns
  FROM (
    VALUES
      ('admin_logs', 1, 'id', 'uuid', true),
      ('admin_logs', 2, 'admin_id', 'uuid', true),
      ('admin_logs', 3, 'action', 'text', true),
      ('admin_logs', 4, 'target_type', 'text', false),
      ('admin_logs', 5, 'target_id', 'uuid', false),
      ('admin_logs', 6, 'details', 'jsonb', false),
      ('comments', 1, 'id', 'uuid', true),
      ('comments', 2, 'post_id', 'uuid', true),
      ('comments', 3, 'user_id', 'uuid', true),
      ('comments', 4, 'deleted_at', 'timestamp with time zone', false),
      ('comments', 5, 'deleted_by', 'uuid', false),
      ('comments', 6, 'delete_reason', 'text', false),
      ('conversations', 1, 'id', 'uuid', true),
      ('conversations', 2, 'user1_id', 'uuid', true),
      ('conversations', 3, 'user2_id', 'uuid', true),
      ('content_reports', 1, 'id', 'uuid', true),
      ('content_reports', 2, 'reporter_id', 'uuid', true),
      ('content_reports', 3, 'content_type', 'text', true),
      ('content_reports', 4, 'content_id', 'text', true),
      ('content_reports', 5, 'reason', 'text', true),
      ('content_reports', 6, 'description', 'text', false),
      ('content_reports', 7, 'images', 'text[]', true),
      ('content_reports', 8, 'status', 'text', true),
      ('content_reports', 9, 'resolved_by', 'uuid', false),
      ('content_reports', 10, 'resolved_at', 'timestamp with time zone', false),
      ('content_reports', 11, 'action_taken', 'text', false),
      ('content_reports', 12, 'created_at', 'timestamp with time zone', false),
      ('posts', 1, 'id', 'uuid', true),
      ('posts', 2, 'author_id', 'uuid', true),
      ('posts', 3, 'deleted_at', 'timestamp with time zone', false),
      ('posts', 4, 'deleted_by', 'uuid', false),
      ('posts', 5, 'delete_reason', 'text', false),
      ('report_evidence_uploads', 1, 'evidence_ref', 'text', true),
      ('report_evidence_uploads', 2, 'reporter_id', 'uuid', true),
      ('report_evidence_uploads', 3, 'object_name', 'text', true),
      ('report_evidence_uploads', 4, 'status', 'text', true),
      ('report_evidence_uploads', 5, 'report_id', 'uuid', false),
      ('report_evidence_uploads', 6, 'expires_at', 'timestamp with time zone', true),
      ('report_evidence_uploads', 7, 'lease_token', 'uuid', false),
      ('report_evidence_uploads', 8, 'lease_expires_at', 'timestamp with time zone', false),
      ('report_evidence_uploads', 9, 'updated_at', 'timestamp with time zone', true),
      ('user_profiles', 1, 'id', 'uuid', true),
      ('user_profiles', 2, 'role', 'text', false),
      ('user_profiles', 3, 'banned_at', 'timestamp with time zone', false),
      ('user_profiles', 4, 'banned_reason', 'text', false),
      ('user_profiles', 5, 'banned_by', 'uuid', false),
      ('user_profiles', 6, 'ban_expires_at', 'timestamp with time zone', false),
      ('user_profiles', 7, 'deleted_at', 'timestamp with time zone', false),
      ('user_strikes', 1, 'id', 'uuid', true),
      ('user_strikes', 2, 'user_id', 'uuid', true),
      ('user_strikes', 3, 'issued_by', 'uuid', false),
      ('user_strikes', 4, 'reason', 'text', true),
      ('user_strikes', 5, 'strike_type', 'text', true),
      ('user_strikes', 6, 'expires_at', 'timestamp with time zone', false),
      ('user_strikes', 7, 'created_at', 'timestamp with time zone', false)
  ) AS required_column(
    table_name,
    ordinality,
    column_name,
    type_name,
    is_not_null
  )
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
     OR (required_column.is_not_null AND NOT attribute.attnotnull);

  IF v_invalid_columns IS NOT NULL THEN
    RAISE EXCEPTION
      'report moderation schema is missing required columns: %',
      v_invalid_columns;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.content_reports'::pg_catalog.regclass
      AND constraint_row.contype = 'c'
      AND constraint_row.convalidated
      AND NOT constraint_row.connoinherit
      AND pg_catalog.pg_get_expr(
        constraint_row.conbin,
        constraint_row.conrelid,
        true
      ) = v_expected_status_check
  ) THEN
    RAISE EXCEPTION
      'content_reports must retain the canonical pending/resolved/dismissed CHECK';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index AS index_metadata
    WHERE index_metadata.indexrelid = pg_catalog.to_regclass(
        'public.uniq_content_reports_pending_reporter_content'
      )
      AND index_metadata.indrelid =
        'public.content_reports'::pg_catalog.regclass
      AND index_metadata.indisunique
      AND index_metadata.indisvalid
      AND index_metadata.indisready
      AND index_metadata.indimmediate
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
  ) THEN
    RAISE EXCEPTION 'canonical pending-report uniqueness index drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('public.user_profiles', 'id', 'auth.users', 'id', 'c'::"char"),
        ('public.user_profiles', 'banned_by', 'auth.users', 'id', 'n'::"char"),
        ('public.content_reports', 'reporter_id', 'auth.users', 'id', 'c'::"char"),
        ('public.content_reports', 'resolved_by', 'auth.users', 'id', 'n'::"char"),
        ('public.admin_logs', 'admin_id', 'auth.users', 'id', 'c'::"char"),
        ('public.user_strikes', 'user_id', 'auth.users', 'id', 'c'::"char"),
        ('public.user_strikes', 'issued_by', 'auth.users', 'id', 'n'::"char"),
        (
          'public.report_evidence_uploads',
          'report_id',
          'public.content_reports',
          'id',
          'n'::"char"
        ),
        ('public.comments', 'post_id', 'public.posts', 'id', 'c'::"char")
    ) AS expected_fk(
      child_relation,
      child_column,
      parent_relation,
      parent_column,
      delete_action
    )
    WHERE (
      SELECT pg_catalog.count(*)
      FROM pg_catalog.pg_constraint AS constraint_row
      WHERE constraint_row.conrelid =
          pg_catalog.to_regclass(expected_fk.child_relation)
        AND constraint_row.contype = 'f'
        AND constraint_row.confrelid =
          pg_catalog.to_regclass(expected_fk.parent_relation)
        AND constraint_row.conkey = ARRAY[
          (
            SELECT attribute.attnum
            FROM pg_catalog.pg_attribute AS attribute
            WHERE attribute.attrelid = constraint_row.conrelid
              AND attribute.attname = expected_fk.child_column
          )
        ]::smallint[]
        AND constraint_row.confkey = ARRAY[
          (
            SELECT attribute.attnum
            FROM pg_catalog.pg_attribute AS attribute
            WHERE attribute.attrelid = constraint_row.confrelid
              AND attribute.attname = expected_fk.parent_column
          )
        ]::smallint[]
        AND constraint_row.confdeltype = expected_fk.delete_action
        AND constraint_row.confupdtype = 'a'
        AND constraint_row.confmatchtype = 's'
        AND constraint_row.convalidated
        AND NOT constraint_row.condeferrable
        AND NOT constraint_row.condeferred
    ) <> 1
  ) THEN
    RAISE EXCEPTION 'report moderation foreign-key authority drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_namespace AS function_schema
      ON function_schema.oid = function_row.pronamespace
    WHERE function_schema.nspname = 'public'
      AND function_row.proname = 'moderate_report_queue_atomic'
      AND (
        v_moderation_function IS NULL
        OR function_row.oid <> v_moderation_function
      )
  ) THEN
    RAISE EXCEPTION
      'unexpected public.moderate_report_queue_atomic overload exists';
  END IF;

  IF v_submit_function IS NULL
     OR v_validator_function IS NULL
     OR v_interaction_function IS NULL
  THEN
    RAISE EXCEPTION
      'canonical report submission dependencies must exist before moderation hardening';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_validator_function
      AND function_row.prokind = 'f'
      AND function_row.prolang = v_sql_oid
      AND function_row.proowner = v_postgres_oid
      AND NOT function_row.prosecdef
      AND function_row.provolatile = 'i'
      AND NOT function_row.proretset
      AND function_row.prorettype = 'boolean'::pg_catalog.regtype
      AND function_row.pronargs = 2
      AND function_row.pronargdefaults = 0
      AND function_row.proargtypes::text = pg_catalog.array_to_string(ARRAY[
        'uuid'::pg_catalog.regtype,
        'text[]'::pg_catalog.regtype
      ]::oid[], ' ')
      AND function_row.proargnames = ARRAY[
        'p_reporter_id',
        'p_images'
      ]::text[]
      AND function_row.proconfig =
        ARRAY['search_path=pg_catalog, pg_temp']::text[]
      AND pg_catalog.md5(function_row.prosrc) =
        'c96971bafe2ba4146990aebcef3bb6f4'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_interaction_function
      AND function_row.prokind = 'f'
      AND function_row.prolang = v_plpgsql_oid
      AND function_row.proowner = v_postgres_oid
      AND function_row.prosecdef
      AND function_row.provolatile = 'v'
      AND NOT function_row.proretset
      AND function_row.prorettype = 'boolean'::pg_catalog.regtype
      AND function_row.pronargs = 2
      AND function_row.pronargdefaults = 0
      AND function_row.proconfig = ARRAY[
        'search_path=pg_catalog, pg_temp',
        'lock_timeout=5s'
      ]::text[]
      AND pg_catalog.md5(function_row.prosrc) =
        '2e5b80845ba4950779148dee421262b0'
  ) THEN
    RAISE EXCEPTION 'report target/evidence validation dependency drifted';
  END IF;

  IF NOT pg_catalog.has_function_privilege(
    'service_role', v_validator_function, 'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'anon', v_validator_function, 'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'authenticated', v_validator_function, 'EXECUTE'
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        function_row.proacl,
        pg_catalog.acldefault('f', function_row.proowner)
      )
    ) AS acl_entry
    WHERE function_row.oid = v_validator_function
      AND acl_entry.grantee NOT IN (
        function_row.proowner,
        v_service_role_oid
      )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(function_row.proacl) AS acl_entry
    WHERE function_row.oid = v_validator_function
      AND acl_entry.grantee = v_service_role_oid
      AND (
        acl_entry.privilege_type <> 'EXECUTE'
        OR acl_entry.is_grantable
      )
  ) OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_proc AS function_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(function_row.proacl) AS acl_entry
    WHERE function_row.oid = v_validator_function
      AND acl_entry.grantee = v_service_role_oid
      AND acl_entry.privilege_type = 'EXECUTE'
      AND NOT acl_entry.is_grantable
  ) <> 1 THEN
    RAISE EXCEPTION 'report evidence validator ACL drifted';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_namespace AS function_schema
      ON function_schema.oid = function_row.pronamespace
    WHERE function_schema.nspname = 'public'
      AND function_row.proname = 'submit_content_report'
  ) <> 1 OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_submit_function
      AND function_row.prokind = 'f'
      AND function_row.prolang = v_plpgsql_oid
      AND function_row.proowner = v_postgres_oid
      AND function_row.prosecdef
      AND function_row.provolatile = 'v'
      AND NOT function_row.proretset
      AND function_row.prorettype = 'jsonb'::pg_catalog.regtype
      AND function_row.pronargs = 6
      AND function_row.pronargdefaults = 2
      AND function_row.proargtypes::text = pg_catalog.array_to_string(ARRAY[
        'uuid'::pg_catalog.regtype,
        'text'::pg_catalog.regtype,
        'uuid'::pg_catalog.regtype,
        'text'::pg_catalog.regtype,
        'text'::pg_catalog.regtype,
        'text[]'::pg_catalog.regtype
      ]::oid[], ' ')
      AND function_row.proallargtypes IS NULL
      AND function_row.proargmodes IS NULL
      AND function_row.proargnames = ARRAY[
        'p_reporter_id',
        'p_content_type',
        'p_content_id',
        'p_reason',
        'p_description',
        'p_images'
      ]::text[]
      AND pg_catalog.pg_get_expr(function_row.proargdefaults, 0) =
        'NULL::text, ARRAY[]::text[]'
      AND function_row.proconfig =
        ARRAY['search_path=pg_catalog, pg_temp']::text[]
  ) THEN
    RAISE EXCEPTION 'submit_content_report function shape drifted';
  END IF;

  IF NOT pg_catalog.has_function_privilege(
    'service_role', v_submit_function, 'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'anon', v_submit_function, 'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'authenticated', v_submit_function, 'EXECUTE'
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        function_row.proacl,
        pg_catalog.acldefault('f', function_row.proowner)
      )
    ) AS acl_entry
    WHERE function_row.oid = v_submit_function
      AND acl_entry.grantee NOT IN (
        function_row.proowner,
        v_service_role_oid
      )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(function_row.proacl) AS acl_entry
    WHERE function_row.oid = v_submit_function
      AND acl_entry.grantee = v_service_role_oid
      AND (
        acl_entry.privilege_type <> 'EXECUTE'
        OR acl_entry.is_grantable
      )
  ) OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_proc AS function_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(function_row.proacl) AS acl_entry
    WHERE function_row.oid = v_submit_function
      AND acl_entry.grantee = v_service_role_oid
      AND acl_entry.privilege_type = 'EXECUTE'
      AND NOT acl_entry.is_grantable
  ) <> 1 THEN
    RAISE EXCEPTION 'submit_content_report ACL drifted';
  END IF;

  SELECT function_row.prosrc
  INTO STRICT v_submit_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_submit_function;

  IF pg_catalog.md5(v_submit_source) NOT IN (
       '4ea38626774271f244389033529ce8ac',
       '62454ccfd4e7efbc21ce7197964cc313'
     ) OR (
       pg_catalog.md5(v_submit_source) =
         '62454ccfd4e7efbc21ce7197964cc313'
       AND pg_catalog.obj_description(
         v_submit_function::oid,
         'pg_proc'
       ) IS DISTINCT FROM
         'atomic-report-moderation-queue:v1:'
           || pg_catalog.md5(v_submit_source)
     ) OR pg_catalog.strpos(
       v_submit_source,
       'public.content_report_evidence_refs_valid'
     ) = 0
     OR pg_catalog.strpos(v_submit_source, '''content-report:''') = 0
     OR pg_catalog.strpos(
       v_submit_source,
       'public.lock_actor_can_interact_with_post'
     ) = 0
     OR pg_catalog.strpos(v_submit_source, 'DUPLICATE_PENDING') = 0
     OR pg_catalog.strpos(
       v_submit_source,
       'FROM public.report_evidence_uploads'
     ) = 0
     OR pg_catalog.strpos(
       v_submit_source,
       'ORDER BY upload_row.evidence_ref'
     ) = 0
     OR pg_catalog.strpos(v_submit_source, 'FROM storage.objects') = 0
     OR pg_catalog.strpos(
       v_submit_source,
       'report evidence claim race detected'
     ) = 0
  THEN
    RAISE EXCEPTION 'submit_content_report source contract drifted';
  END IF;

  IF v_moderation_function IS NOT NULL THEN
    SELECT function_row.prosrc
    INTO STRICT v_moderation_source
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_moderation_function;

    IF pg_catalog.md5(v_moderation_source) <>
         '50c413fbae8ce4e83b16e6c1466c5d25'
       OR pg_catalog.obj_description(
         v_moderation_function::oid,
         'pg_proc'
       ) IS DISTINCT FROM
         'atomic-report-moderation-queue:v1:'
           || pg_catalog.md5(v_moderation_source)
    THEN
      RAISE EXCEPTION 'replayed moderation RPC source seal drifted';
    END IF;
  END IF;
END
$preflight$;

-- Keep the preflight and function replacement in one stable schema snapshot.
-- Auth is first so the DDL cutover itself follows hard-delete parent -> child.
LOCK TABLE auth.users IN SHARE MODE;

LOCK TABLE public.posts,
  public.comments,
  public.conversations,
  public.user_profiles,
  public.user_strikes,
  public.content_reports,
  public.report_evidence_uploads,
  public.admin_logs
  IN SHARE ROW EXCLUSIVE MODE;

-- Storage may be managed/partitioned by Supabase, so stabilize only its schema
-- contract while allowing ordinary object traffic during this cutover.
LOCK TABLE storage.objects IN ACCESS SHARE MODE;

-- The original strikes migration declared issued_by NOT NULL together with
-- ON DELETE SET NULL. That contradictory shape can block auth-user hard
-- deletion on databases rebuilt from migration history. Normalize it under
-- the parent-first cutover locks; this is idempotent on already-correct hosts.
ALTER TABLE public.user_strikes
  ALTER COLUMN issued_by DROP NOT NULL;

CREATE OR REPLACE FUNCTION public.submit_content_report(
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

  -- This target lock is the linearization point shared with moderation. It and
  -- the reporter-specific deduplication lock precede every profile/content row
  -- lock, preventing report insertion from straddling a moderation snapshot.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'report-moderation:' || p_content_type || ':' || p_content_id::text,
      0
    )
  );

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'content-report:'
        || p_reporter_id::text
        || ':' || p_content_type
        || ':' || p_content_id::text,
      0
    )
  );

  -- Auth hard deletion locks auth.users first and then cascades into the
  -- reporter profile/report/evidence children. Match that parent-first order
  -- before taking any child row lock or inserting the report FK edge.
  PERFORM 1
  FROM auth.users AS reporter_auth_user
  WHERE reporter_auth_user.id = p_reporter_id
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'active reporter identity required';
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

CREATE OR REPLACE FUNCTION public.moderate_report_queue_atomic(
  p_actor_id uuid,
  p_content_type text,
  p_content_id uuid,
  p_action text
)
RETURNS TABLE (
  applied boolean,
  result_action text,
  result_content_type text,
  result_content_id uuid,
  report_status text,
  report_count integer,
  action_taken text,
  author_id uuid,
  content_soft_deleted boolean,
  content_affected_count integer,
  strike_id uuid,
  strike_type text
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_action_taken text;
  v_admin_log_action text;
  v_admin_log_target_id uuid;
  v_admin_log_target_type text;
  v_author_id uuid;
  v_auth_user_id uuid;
  v_candidate_author_id uuid;
  v_candidate_parent_author_id uuid;
  v_candidate_post_id uuid;
  v_comment_affected_count integer := 0;
  v_comment_count integer;
  v_comment_post_id uuid;
  v_content_affected_count integer := 0;
  v_content_exists boolean := false;
  v_content_soft_deleted boolean;
  v_locked_deleted_at timestamptz;
  v_locked_auth_ids uuid[] := ARRAY[]::uuid[];
  v_locked_parent_author_id uuid;
  v_locked_post_id uuid;
  v_history_report_ids uuid[] := ARRAY[]::uuid[];
  v_latest_action_taken_max text;
  v_latest_action_taken_min text;
  v_latest_report_ids uuid[] := ARRAY[]::uuid[];
  v_latest_report_status_max text;
  v_latest_report_status_min text;
  v_latest_resolved_at timestamptz;
  v_latest_resolver_variant_count integer;
  v_next_report_status text;
  v_now timestamptz;
  v_report_ids uuid[] := ARRAY[]::uuid[];
  v_report_update_count integer;
  v_required_auth_ids uuid[] := ARRAY[]::uuid[];
  v_strike_count integer;
  v_strike_expires_at timestamptz;
  v_strike_id uuid;
  v_strike_reason text;
  v_strike_type text;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'service role required';
  END IF;

  IF p_actor_id IS NULL
     OR p_content_id IS NULL
     OR p_content_type NOT IN ('post', 'comment')
     OR p_action NOT IN ('approve', 'delete', 'warn', 'ban')
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'invalid report moderation input';
  END IF;

  -- Every submit and moderation action for one target linearizes before any
  -- profile/content row lock. submit_content_report takes this exact key first.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'report-moderation:' || p_content_type || ':' || p_content_id::text,
      0
    )
  );

  -- Discover the immutable identity upper bound without taking child locks.
  -- Auth deletion may win this observation race; the ordered auth lock/check
  -- below then fails closed without holding a profile/content child.
  IF p_content_type = 'post' THEN
    SELECT post_row.author_id
    INTO v_candidate_author_id
    FROM public.posts AS post_row
    WHERE post_row.id = p_content_id;

    v_content_exists := FOUND;
  ELSE
    SELECT
      comment_row.post_id,
      comment_row.user_id,
      parent_post.author_id
    INTO
      v_candidate_post_id,
      v_candidate_author_id,
      v_candidate_parent_author_id
    FROM public.comments AS comment_row
    LEFT JOIN public.posts AS parent_post
      ON parent_post.id = comment_row.post_id
    WHERE comment_row.id = p_content_id;

    v_content_exists := FOUND;

    IF v_content_exists AND v_candidate_parent_author_id IS NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23503',
        MESSAGE = 'reported comment parent post is missing';
    END IF;
  END IF;

  SELECT pg_catalog.array_agg(required_id ORDER BY required_id)
  INTO STRICT v_required_auth_ids
  FROM (
    SELECT DISTINCT required_id
    FROM pg_catalog.unnest(ARRAY[
      p_actor_id,
      v_candidate_author_id,
      v_candidate_parent_author_id
    ]::uuid[]) AS required_auth(required_id)
    WHERE required_id IS NOT NULL
  ) AS required_auth_identity;

  -- Every auth parent is locked in UUID order before sanction advisory locks
  -- and before the first profile/content/report child row. Auth hard deletion
  -- takes the same parent-before-child direction, eliminating both actor and
  -- content-author deadlock cycles.
  FOR v_auth_user_id IN
    SELECT auth_user.id
    FROM auth.users AS auth_user
    WHERE auth_user.id = ANY (v_required_auth_ids)
    ORDER BY auth_user.id
    FOR SHARE
  LOOP
    v_locked_auth_ids := pg_catalog.array_append(
      v_locked_auth_ids,
      v_auth_user_id
    );
  END LOOP;

  IF NOT p_actor_id = ANY (v_locked_auth_ids) THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'administrator identity is unavailable';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.unnest(v_required_auth_ids) AS required_auth(required_id)
    WHERE NOT required_id = ANY (v_locked_auth_ids)
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0002',
      MESSAGE = 'reported content identity is unavailable';
  END IF;

  -- Different targets owned by one author share this lock. Auth parents are
  -- already stable, so every queue sanction follows target -> auth -> sanction
  -- -> child rows and can never invert that order.
  IF v_content_exists AND p_action IN ('warn', 'ban') THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'report-moderation-sanction:' || v_candidate_author_id::text,
        0
      )
    );
  END IF;

  PERFORM 1
  FROM public.user_profiles AS actor_profile
  WHERE actor_profile.id = p_actor_id
    AND actor_profile.role = 'admin'
    AND actor_profile.banned_at IS NULL
    AND actor_profile.deleted_at IS NULL
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'active administrator profile required';
  END IF;

  IF p_content_type = 'post' AND v_content_exists THEN
    SELECT post_row.author_id, post_row.deleted_at
    INTO v_author_id, v_locked_deleted_at
    FROM public.posts AS post_row
    WHERE post_row.id = p_content_id
    FOR UPDATE;

    IF NOT FOUND OR v_author_id IS DISTINCT FROM v_candidate_author_id THEN
      RAISE EXCEPTION USING
        ERRCODE = '40001',
        MESSAGE = 'reported post identity changed during moderation';
    END IF;
  ELSIF p_content_type = 'comment' AND v_content_exists THEN
    SELECT parent_post.author_id
    INTO v_locked_parent_author_id
    FROM public.posts AS parent_post
    WHERE parent_post.id = v_candidate_post_id
    FOR UPDATE;

    IF NOT FOUND
       OR v_locked_parent_author_id IS DISTINCT FROM
         v_candidate_parent_author_id
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '40001',
        MESSAGE = 'reported comment parent identity changed during moderation';
    END IF;

    SELECT comment_row.post_id, comment_row.user_id, comment_row.deleted_at
    INTO v_locked_post_id, v_author_id, v_locked_deleted_at
    FROM public.comments AS comment_row
    WHERE comment_row.id = p_content_id
      AND comment_row.post_id = v_candidate_post_id
    FOR UPDATE;

    IF NOT FOUND
       OR v_locked_post_id IS DISTINCT FROM v_candidate_post_id
       OR v_author_id IS DISTINCT FROM v_candidate_author_id
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '40001',
        MESSAGE = 'reported comment identity changed during moderation';
    END IF;
  END IF;

  SELECT COALESCE(
    pg_catalog.array_agg(locked_report.id ORDER BY locked_report.id),
    ARRAY[]::uuid[]
  )
  INTO v_report_ids
  FROM (
    SELECT report_row.id
    FROM public.content_reports AS report_row
    WHERE report_row.content_type = p_content_type
      AND report_row.content_id = p_content_id::text
      AND report_row.status = 'pending'
    ORDER BY report_row.id
    FOR UPDATE
  ) AS locked_report;

  result_action := p_action;
  result_content_type := p_content_type;
  result_content_id := p_content_id;
  author_id := v_author_id;
  report_count := pg_catalog.cardinality(v_report_ids);
  strike_id := NULL;
  strike_type := NULL;
  content_affected_count := 0;
  v_content_soft_deleted := CASE
    WHEN v_content_exists THEN v_locked_deleted_at IS NOT NULL
    ELSE NULL
  END;
  content_soft_deleted := v_content_soft_deleted;

  -- No pending rows alone do not prove a retry: a random target and a
  -- cross-action request have the same surface shape. Lock all processed rows,
  -- bind replay evidence to the latest non-null resolved_at batch, and require
  -- that entire batch to carry one canonical status/action/resolver identity.
  -- This prevents an arbitrary older matching row from hiding a newer conflict.
  IF report_count = 0 THEN
    SELECT COALESCE(
      pg_catalog.array_agg(locked_history.id ORDER BY locked_history.id),
      ARRAY[]::uuid[]
    )
    INTO v_history_report_ids
    FROM (
      SELECT report_row.id
      FROM public.content_reports AS report_row
      WHERE report_row.content_type = p_content_type
        AND report_row.content_id = p_content_id::text
        AND report_row.status <> 'pending'
      ORDER BY report_row.id
      FOR UPDATE
    ) AS locked_history;

    IF pg_catalog.cardinality(v_history_report_ids) = 0 THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0002',
        MESSAGE = 'processed report history not found';
    END IF;

    SELECT pg_catalog.max(history_report.resolved_at)
    INTO v_latest_resolved_at
    FROM public.content_reports AS history_report
    WHERE history_report.id = ANY (v_history_report_ids);

    IF v_latest_resolved_at IS NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '40001',
        MESSAGE = 'latest moderation history is incomplete';
    END IF;

    SELECT
      COALESCE(
        pg_catalog.array_agg(
          history_report.id ORDER BY history_report.id
        ),
        ARRAY[]::uuid[]
      ),
      pg_catalog.min(history_report.status),
      pg_catalog.max(history_report.status),
      pg_catalog.min(history_report.action_taken),
      pg_catalog.max(history_report.action_taken),
      (
        pg_catalog.count(DISTINCT history_report.resolved_by)
        + CASE
          WHEN pg_catalog.bool_or(history_report.resolved_by IS NULL) THEN 1
          ELSE 0
        END
      )::integer
    INTO
      v_latest_report_ids,
      v_latest_report_status_min,
      v_latest_report_status_max,
      v_latest_action_taken_min,
      v_latest_action_taken_max,
      v_latest_resolver_variant_count
    FROM public.content_reports AS history_report
    WHERE history_report.id = ANY (v_history_report_ids)
      AND history_report.resolved_at = v_latest_resolved_at;

    IF pg_catalog.cardinality(v_latest_report_ids) = 0
       OR v_latest_resolver_variant_count <> 1
       OR v_latest_report_status_min IS DISTINCT FROM
         v_latest_report_status_max
       OR v_latest_action_taken_min IS DISTINCT FROM
         v_latest_action_taken_max
       OR (
         p_action = 'approve'
         AND (
           v_latest_report_status_min IS DISTINCT FROM 'dismissed'
           OR v_latest_action_taken_min IS DISTINCT FROM 'approved_content'
         )
       )
       OR (
         p_action = 'delete'
         AND (
           v_latest_report_status_min IS DISTINCT FROM 'resolved'
           OR v_latest_action_taken_min IS NULL
           OR v_latest_action_taken_min NOT IN (
             'content_deleted',
             'content_already_absent'
           )
         )
       )
       OR (
         p_action = 'warn'
         AND (
           v_latest_report_status_min IS DISTINCT FROM 'resolved'
           OR v_latest_action_taken_min IS DISTINCT FROM 'user_warned'
         )
       )
       OR (
         p_action = 'ban'
         AND (
           v_latest_report_status_min IS DISTINCT FROM 'resolved'
           OR v_latest_action_taken_min IS DISTINCT FROM 'user_banned'
         )
       )
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '40001',
        MESSAGE = 'latest moderation action conflicts with request';
    END IF;

    applied := false;
    report_status := v_latest_report_status_min;
    report_count := pg_catalog.cardinality(v_latest_report_ids);
    action_taken := v_latest_action_taken_min;
    RETURN NEXT;
    RETURN;
  END IF;

  IF p_action IN ('warn', 'ban') AND NOT v_content_exists THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0002',
      MESSAGE = 'reported content no longer exists';
  END IF;

  IF p_action IN ('warn', 'ban') AND v_author_id = p_actor_id THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'administrator cannot sanction self';
  END IF;

  -- Timestamp effects only after the target/report locks have been acquired;
  -- time spent waiting for a concurrent submit/moderation action is excluded.
  v_now := pg_catalog.clock_timestamp();

  IF p_action IN ('warn', 'ban') THEN
    PERFORM 1
    FROM public.user_profiles AS target_profile
    WHERE target_profile.id = v_author_id
      AND target_profile.deleted_at IS NULL
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0002',
        MESSAGE = 'reported content author is unavailable';
    END IF;
  END IF;

  IF p_action = 'approve' THEN
    v_next_report_status := 'dismissed';
    v_action_taken := 'approved_content';
    v_admin_log_action := 'dismiss_reports';
    v_admin_log_target_type := p_content_type;
    v_admin_log_target_id := p_content_id;
  ELSIF p_action = 'warn' THEN
    SELECT pg_catalog.count(*)::integer
    INTO v_strike_count
    FROM public.user_strikes AS strike_row
    WHERE strike_row.user_id = v_author_id;

    IF v_strike_count >= 4 THEN
      v_strike_type := 'perm_ban';
      v_strike_reason := pg_catalog.format(
        'Auto-escalation (strike #%s): Reported %s (%s)',
        v_strike_count + 1,
        p_content_type,
        p_content_id
      );
      v_strike_expires_at := NULL;
      v_admin_log_action := 'issue_perm_ban';
    ELSIF v_strike_count = 3 THEN
      v_strike_type := 'temp_ban';
      v_strike_reason := pg_catalog.format(
        'Auto-escalation (strike #4): Reported %s (%s)',
        p_content_type,
        p_content_id
      );
      v_strike_expires_at := v_now + pg_catalog.make_interval(days => 7);
      v_admin_log_action := 'issue_temp_ban';
    ELSIF v_strike_count = 2 THEN
      v_strike_type := 'mute';
      v_strike_reason := pg_catalog.format(
        'Auto-escalation (strike #3): Reported %s (%s)',
        p_content_type,
        p_content_id
      );
      v_strike_expires_at := v_now + pg_catalog.make_interval(days => 3);
      v_admin_log_action := 'issue_mute';
    ELSE
      v_strike_type := 'warning';
      v_strike_reason := pg_catalog.format(
        'Auto-escalation (strike #%s): Reported %s (%s)',
        v_strike_count + 1,
        p_content_type,
        p_content_id
      );
      v_strike_expires_at := NULL;
      v_admin_log_action := 'issue_warning';
    END IF;

    INSERT INTO public.user_strikes (
      user_id,
      issued_by,
      reason,
      strike_type,
      expires_at
    ) VALUES (
      v_author_id,
      p_actor_id,
      v_strike_reason,
      v_strike_type,
      v_strike_expires_at
    )
    RETURNING id INTO v_strike_id;

    IF v_strike_type = 'temp_ban' THEN
      UPDATE public.user_profiles AS target_profile
      SET banned_at = v_now,
          banned_reason = v_strike_reason,
          banned_by = p_actor_id,
          ban_expires_at = v_strike_expires_at
      WHERE target_profile.id = v_author_id;
    ELSIF v_strike_type = 'perm_ban' THEN
      UPDATE public.user_profiles AS target_profile
      SET banned_at = v_now,
          banned_reason = v_strike_reason,
          banned_by = p_actor_id,
          ban_expires_at = NULL
      WHERE target_profile.id = v_author_id;
    END IF;

    v_next_report_status := 'resolved';
    v_action_taken := 'user_warned';
    v_admin_log_target_type := 'user';
    v_admin_log_target_id := v_author_id;
  ELSIF p_action = 'ban' THEN
    UPDATE public.user_profiles AS target_profile
    SET banned_at = v_now,
        banned_reason = pg_catalog.format(
          'Banned for reported %s',
          p_content_type
        ),
        banned_by = p_actor_id,
        ban_expires_at = NULL
    WHERE target_profile.id = v_author_id;

    v_next_report_status := 'resolved';
    v_action_taken := 'user_banned';
    v_admin_log_action := 'ban_user_from_queue';
    v_admin_log_target_type := 'user';
    v_admin_log_target_id := v_author_id;
  ELSE
    v_next_report_status := 'resolved';
    v_action_taken := CASE
      WHEN v_content_exists AND v_locked_deleted_at IS NULL
        THEN 'content_deleted'
      ELSE 'content_already_absent'
    END;
    v_admin_log_action := 'delete_content';
    v_admin_log_target_type := p_content_type;
    v_admin_log_target_id := p_content_id;
  END IF;

  IF p_action IN ('delete', 'ban')
     AND v_content_exists
     AND v_locked_deleted_at IS NULL
  THEN
    IF p_content_type = 'post' THEN
      UPDATE public.posts AS moderated_post
      SET deleted_at = v_now,
          deleted_by = p_actor_id,
          delete_reason = CASE
            WHEN p_action = 'ban'
              THEN 'Author banned for reported post'
            ELSE 'Deleted from moderation queue'
          END
      WHERE moderated_post.id = p_content_id
        AND moderated_post.deleted_at IS NULL;
      GET DIAGNOSTICS v_content_affected_count = ROW_COUNT;
      v_content_soft_deleted := true;
    ELSE
      SELECT
        moderation_result.post_id,
        moderation_result.affected_count,
        moderation_result.comment_count
      INTO
        v_comment_post_id,
        v_comment_affected_count,
        v_comment_count
      FROM public.moderate_comment(
        p_content_id,
        p_actor_id,
        'soft_delete',
        CASE
          WHEN p_action = 'ban'
            THEN 'Author banned for reported comment'
          ELSE 'Deleted from moderation queue'
        END
      ) AS moderation_result;

      IF NOT FOUND
         OR v_comment_post_id IS DISTINCT FROM v_candidate_post_id
         OR v_comment_affected_count < 0
         OR v_comment_count < 0
      THEN
        RAISE EXCEPTION USING
          ERRCODE = '40001',
          MESSAGE = 'comment moderation acknowledgement is invalid';
      END IF;

      v_content_affected_count := v_comment_affected_count;
      v_content_soft_deleted := true;
    END IF;

    IF v_content_affected_count < 1 THEN
      RAISE EXCEPTION USING
        ERRCODE = '40001',
        MESSAGE = 'active content soft-delete acknowledgement is invalid';
    END IF;
  END IF;

  UPDATE public.content_reports AS transitioned_report
  SET status = v_next_report_status,
      resolved_by = p_actor_id,
      resolved_at = v_now,
      action_taken = v_action_taken
  WHERE transitioned_report.id = ANY (v_report_ids)
    AND transitioned_report.status = 'pending'
    AND transitioned_report.content_type = p_content_type
    AND transitioned_report.content_id = p_content_id::text;
  GET DIAGNOSTICS v_report_update_count = ROW_COUNT;

  IF v_report_update_count <> pg_catalog.cardinality(v_report_ids) THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'pending report transition race detected';
  END IF;

  INSERT INTO public.admin_logs (
    admin_id,
    action,
    target_type,
    target_id,
    details
  ) VALUES (
    p_actor_id,
    v_admin_log_action,
    v_admin_log_target_type,
    v_admin_log_target_id,
    pg_catalog.jsonb_build_object(
      'content_type', p_content_type,
      'content_id', p_content_id,
      'report_count', pg_catalog.cardinality(v_report_ids),
      'report_ids', pg_catalog.to_jsonb(v_report_ids),
      'report_status', v_next_report_status,
      'action_taken', v_action_taken,
      'author_id', v_author_id,
      'content_affected_count', v_content_affected_count,
      'strike_id', v_strike_id,
      'strike_type', v_strike_type
    )
  );

  applied := true;
  report_status := v_next_report_status;
  report_count := pg_catalog.cardinality(v_report_ids);
  action_taken := v_action_taken;
  author_id := v_author_id;
  content_soft_deleted := v_content_soft_deleted;
  content_affected_count := v_content_affected_count;
  strike_id := v_strike_id;
  strike_type := v_strike_type;
  RETURN NEXT;
END
$function$;

ALTER FUNCTION public.moderate_report_queue_atomic(uuid, text, uuid, text)
  OWNER TO postgres;

REVOKE ALL ON FUNCTION public.moderate_report_queue_atomic(uuid, text, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.moderate_report_queue_atomic(uuid, text, uuid, text)
  TO service_role;

DO $seal_functions$
DECLARE
  v_function pg_catalog.regprocedure;
  v_digest text;
BEGIN
  FOREACH v_function IN ARRAY ARRAY[
    'public.submit_content_report(uuid,text,uuid,text,text,text[])'::pg_catalog.regprocedure,
    'public.moderate_report_queue_atomic(uuid,text,uuid,text)'::pg_catalog.regprocedure
  ]::pg_catalog.regprocedure[]
  LOOP
    SELECT pg_catalog.md5(function_row.prosrc)
    INTO STRICT v_digest
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_function;

    EXECUTE pg_catalog.format(
      'COMMENT ON FUNCTION %s IS %L',
      v_function,
      'atomic-report-moderation-queue:v1:' || v_digest
    );
  END LOOP;
END
$seal_functions$;

DO $postflight$
DECLARE
  v_moderation_function pg_catalog.regprocedure :=
    'public.moderate_report_queue_atomic(uuid,text,uuid,text)'::pg_catalog.regprocedure;
  v_submit_function pg_catalog.regprocedure :=
    'public.submit_content_report(uuid,text,uuid,text,text,text[])'::pg_catalog.regprocedure;
  v_validator_function pg_catalog.regprocedure :=
    'public.content_report_evidence_refs_valid(uuid,text[])'::pg_catalog.regprocedure;
  v_interaction_function pg_catalog.regprocedure :=
    'public.lock_actor_can_interact_with_post(uuid,uuid)'::pg_catalog.regprocedure;
  v_postgres_oid oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'postgres'
  );
  v_service_role_oid oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'service_role'
  );
  v_plpgsql_oid oid := (
    SELECT language_row.oid
    FROM pg_catalog.pg_language AS language_row
    WHERE language_row.lanname = 'plpgsql'
  );
  v_sql_oid oid := (
    SELECT language_row.oid
    FROM pg_catalog.pg_language AS language_row
    WHERE language_row.lanname = 'sql'
  );
  v_relation_name text;
  v_relation pg_catalog.regclass;
  v_function pg_catalog.regprocedure;
  v_submit_source text;
  v_moderation_source text;
  v_auth_lock_position integer;
  v_target_lock_position integer;
  v_reporter_lock_position integer;
  v_sanction_lock_position integer;
  v_profile_lock_position integer;
BEGIN
  FOREACH v_relation_name IN ARRAY ARRAY[
    'content_reports',
    'posts',
    'comments',
    'conversations',
    'user_profiles',
    'report_evidence_uploads',
    'user_strikes',
    'admin_logs'
  ]::text[]
  LOOP
    v_relation := pg_catalog.to_regclass(
      pg_catalog.format('public.%I', v_relation_name)
    );

    IF (
      SELECT relation.relkind = 'r'
        AND relation.relpersistence = 'p'
        AND NOT relation.relispartition
      FROM pg_catalog.pg_class AS relation
      WHERE relation.oid = v_relation
    ) IS NOT TRUE OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_inherits AS inheritance
      WHERE inheritance.inhrelid = v_relation
         OR inheritance.inhparent = v_relation
    ) OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_rewrite AS rewrite_rule
      WHERE rewrite_rule.ev_class = v_relation
    ) THEN
      RAISE EXCEPTION
        'postflight relation shape drifted for public.%',
        v_relation_name;
    END IF;
  END LOOP;

  v_relation := pg_catalog.to_regclass('auth.users');
  IF (
    SELECT relation.relkind = 'r'
      AND relation.relpersistence = 'p'
      AND NOT relation.relispartition
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = v_relation
  ) IS NOT TRUE OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_inherits AS inheritance
    WHERE inheritance.inhrelid = v_relation
       OR inheritance.inhparent = v_relation
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_rewrite AS rewrite_rule
    WHERE rewrite_rule.ev_class = v_relation
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = v_relation
      AND attribute.attname = 'id'
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND attribute.atttypid = 'uuid'::pg_catalog.regtype
      AND attribute.attnotnull
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index AS index_metadata
    WHERE index_metadata.indrelid = v_relation
      AND index_metadata.indisunique
      AND index_metadata.indisvalid
      AND index_metadata.indisready
      AND index_metadata.indimmediate
      AND index_metadata.indpred IS NULL
      AND index_metadata.indexprs IS NULL
      AND index_metadata.indnkeyatts = 1
      AND index_metadata.indnatts = 1
      AND index_metadata.indkey[0] = (
        SELECT attribute.attnum
        FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid = v_relation
          AND attribute.attname = 'id'
      )
  ) THEN
    RAISE EXCEPTION 'postflight auth.users authority drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('public.user_profiles', 'id', 'auth.users', 'id', 'c'::"char"),
        ('public.user_profiles', 'banned_by', 'auth.users', 'id', 'n'::"char"),
        ('public.content_reports', 'reporter_id', 'auth.users', 'id', 'c'::"char"),
        ('public.content_reports', 'resolved_by', 'auth.users', 'id', 'n'::"char"),
        ('public.admin_logs', 'admin_id', 'auth.users', 'id', 'c'::"char"),
        ('public.user_strikes', 'user_id', 'auth.users', 'id', 'c'::"char"),
        ('public.user_strikes', 'issued_by', 'auth.users', 'id', 'n'::"char"),
        (
          'public.report_evidence_uploads',
          'report_id',
          'public.content_reports',
          'id',
          'n'::"char"
        ),
        ('public.comments', 'post_id', 'public.posts', 'id', 'c'::"char")
    ) AS expected_fk(
      child_relation,
      child_column,
      parent_relation,
      parent_column,
      delete_action
    )
    WHERE (
      SELECT pg_catalog.count(*)
      FROM pg_catalog.pg_constraint AS constraint_row
      WHERE constraint_row.conrelid =
          pg_catalog.to_regclass(expected_fk.child_relation)
        AND constraint_row.contype = 'f'
        AND constraint_row.confrelid =
          pg_catalog.to_regclass(expected_fk.parent_relation)
        AND constraint_row.conkey = ARRAY[
          (
            SELECT attribute.attnum
            FROM pg_catalog.pg_attribute AS attribute
            WHERE attribute.attrelid = constraint_row.conrelid
              AND attribute.attname = expected_fk.child_column
          )
        ]::smallint[]
        AND constraint_row.confkey = ARRAY[
          (
            SELECT attribute.attnum
            FROM pg_catalog.pg_attribute AS attribute
            WHERE attribute.attrelid = constraint_row.confrelid
              AND attribute.attname = expected_fk.parent_column
          )
        ]::smallint[]
        AND constraint_row.confdeltype = expected_fk.delete_action
        AND constraint_row.confupdtype = 'a'
        AND constraint_row.confmatchtype = 's'
        AND constraint_row.convalidated
        AND NOT constraint_row.condeferrable
        AND NOT constraint_row.condeferred
    ) <> 1
  ) THEN
    RAISE EXCEPTION 'postflight report moderation FK authority drifted';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = 'public.user_strikes'::pg_catalog.regclass
      AND attribute.attname = 'issued_by'
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND attribute.atttypid = 'uuid'::pg_catalog.regtype
      AND NOT attribute.attnotnull
  ) THEN
    RAISE EXCEPTION 'user_strikes.issued_by must permit ON DELETE SET NULL';
  END IF;

  IF pg_catalog.to_regclass('storage.objects') IS NULL OR EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('bucket_id', 'text'),
        ('name', 'text')
    ) AS required_column(column_name, type_name)
    LEFT JOIN pg_catalog.pg_attribute AS attribute
      ON attribute.attrelid = pg_catalog.to_regclass('storage.objects')
     AND attribute.attname = required_column.column_name
     AND attribute.attnum > 0
     AND NOT attribute.attisdropped
    WHERE attribute.attname IS NULL
       OR pg_catalog.format_type(attribute.atttypid, attribute.atttypmod)
            <> required_column.type_name
  ) THEN
    RAISE EXCEPTION 'postflight storage.objects contract drifted';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_namespace AS function_schema
      ON function_schema.oid = function_row.pronamespace
    WHERE function_schema.nspname = 'public'
      AND function_row.proname IN (
        'submit_content_report',
        'moderate_report_queue_atomic'
      )
  ) <> 2 OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_namespace AS function_schema
      ON function_schema.oid = function_row.pronamespace
    WHERE function_schema.nspname = 'public'
      AND function_row.proname = 'submit_content_report'
  ) <> 1 OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_namespace AS function_schema
      ON function_schema.oid = function_row.pronamespace
    WHERE function_schema.nspname = 'public'
      AND function_row.proname = 'moderate_report_queue_atomic'
  ) <> 1 THEN
    RAISE EXCEPTION 'report RPC routine inventory drifted';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_submit_function
      AND function_row.prokind = 'f'
      AND function_row.prolang = v_plpgsql_oid
      AND function_row.proowner = v_postgres_oid
      AND function_row.prosecdef
      AND function_row.provolatile = 'v'
      AND NOT function_row.proretset
      AND function_row.prorettype = 'jsonb'::pg_catalog.regtype
      AND function_row.pronargs = 6
      AND function_row.pronargdefaults = 2
      AND function_row.proargtypes::text = pg_catalog.array_to_string(ARRAY[
        'uuid'::pg_catalog.regtype,
        'text'::pg_catalog.regtype,
        'uuid'::pg_catalog.regtype,
        'text'::pg_catalog.regtype,
        'text'::pg_catalog.regtype,
        'text[]'::pg_catalog.regtype
      ]::oid[], ' ')
      AND function_row.proallargtypes IS NULL
      AND function_row.proargmodes IS NULL
      AND function_row.proargnames = ARRAY[
        'p_reporter_id',
        'p_content_type',
        'p_content_id',
        'p_reason',
        'p_description',
        'p_images'
      ]::text[]
      AND pg_catalog.pg_get_expr(function_row.proargdefaults, 0) =
        'NULL::text, ARRAY[]::text[]'
      AND function_row.proconfig = ARRAY[
        'search_path=pg_catalog, pg_temp'
      ]::text[]
  ) THEN
    RAISE EXCEPTION 'submit_content_report metadata drifted';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_moderation_function
      AND function_row.prokind = 'f'
      AND function_row.prolang = v_plpgsql_oid
      AND function_row.proowner = v_postgres_oid
      AND function_row.prosecdef
      AND function_row.provolatile = 'v'
      AND function_row.proretset
      AND function_row.prorettype = 'record'::pg_catalog.regtype
      AND function_row.pronargs = 4
      AND function_row.pronargdefaults = 0
      AND function_row.proargtypes::text = pg_catalog.array_to_string(ARRAY[
        'uuid'::pg_catalog.regtype,
        'text'::pg_catalog.regtype,
        'uuid'::pg_catalog.regtype,
        'text'::pg_catalog.regtype
      ]::oid[], ' ')
      AND function_row.proallargtypes = ARRAY[
        'uuid'::pg_catalog.regtype,
        'text'::pg_catalog.regtype,
        'uuid'::pg_catalog.regtype,
        'text'::pg_catalog.regtype,
        'boolean'::pg_catalog.regtype,
        'text'::pg_catalog.regtype,
        'text'::pg_catalog.regtype,
        'uuid'::pg_catalog.regtype,
        'text'::pg_catalog.regtype,
        'integer'::pg_catalog.regtype,
        'text'::pg_catalog.regtype,
        'uuid'::pg_catalog.regtype,
        'boolean'::pg_catalog.regtype,
        'integer'::pg_catalog.regtype,
        'uuid'::pg_catalog.regtype,
        'text'::pg_catalog.regtype
      ]::oid[]
      AND function_row.proargmodes = ARRAY[
        'i'::"char",
        'i'::"char",
        'i'::"char",
        'i'::"char",
        't'::"char",
        't'::"char",
        't'::"char",
        't'::"char",
        't'::"char",
        't'::"char",
        't'::"char",
        't'::"char",
        't'::"char",
        't'::"char",
        't'::"char",
        't'::"char"
      ]::"char"[]
      AND function_row.proargnames = ARRAY[
        'p_actor_id',
        'p_content_type',
        'p_content_id',
        'p_action',
        'applied',
        'result_action',
        'result_content_type',
        'result_content_id',
        'report_status',
        'report_count',
        'action_taken',
        'author_id',
        'content_soft_deleted',
        'content_affected_count',
        'strike_id',
        'strike_type'
      ]::text[]
      AND function_row.proconfig = ARRAY[
        'search_path=pg_catalog, pg_temp',
        'lock_timeout=5s'
      ]::text[]
  ) THEN
    RAISE EXCEPTION 'atomic report moderation RPC metadata drifted';
  END IF;

  FOREACH v_function IN ARRAY ARRAY[
    v_submit_function,
    v_moderation_function
  ]::pg_catalog.regprocedure[]
  LOOP
    IF NOT pg_catalog.has_function_privilege(
      'service_role', v_function, 'EXECUTE'
    ) OR pg_catalog.has_function_privilege(
      'anon', v_function, 'EXECUTE'
    ) OR pg_catalog.has_function_privilege(
      'authenticated', v_function, 'EXECUTE'
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
        AND acl_entry.grantee NOT IN (
          function_row.proowner,
          v_service_role_oid
        )
    ) OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS function_row
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        function_row.proacl
      ) AS acl_entry
      WHERE function_row.oid = v_function
        AND acl_entry.grantee = v_service_role_oid
        AND (
          acl_entry.privilege_type <> 'EXECUTE'
          OR acl_entry.is_grantable
        )
    ) OR (
      SELECT pg_catalog.count(*)
      FROM pg_catalog.pg_proc AS function_row
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        function_row.proacl
      ) AS acl_entry
      WHERE function_row.oid = v_function
        AND acl_entry.grantee = v_service_role_oid
        AND acl_entry.privilege_type = 'EXECUTE'
        AND NOT acl_entry.is_grantable
    ) <> 1 THEN
      RAISE EXCEPTION 'service-only function ACL drifted: %', v_function;
    END IF;
  END LOOP;

  SELECT function_row.prosrc
  INTO STRICT v_submit_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_submit_function;

  v_target_lock_position := pg_catalog.strpos(
    v_submit_source,
    '''report-moderation:'''
  );
  v_reporter_lock_position := pg_catalog.strpos(
    v_submit_source,
    '''content-report:'''
  );
  v_auth_lock_position := pg_catalog.strpos(
    v_submit_source,
    'FROM auth.users AS reporter_auth_user'
  );
  v_profile_lock_position := pg_catalog.strpos(
    v_submit_source,
    'FROM public.user_profiles AS reporter'
  );

  IF pg_catalog.md5(v_submit_source) <>
       '62454ccfd4e7efbc21ce7197964cc313'
     OR pg_catalog.obj_description(
       v_submit_function::oid,
       'pg_proc'
     ) IS DISTINCT FROM
       'atomic-report-moderation-queue:v1:'
         || pg_catalog.md5(v_submit_source)
     OR v_target_lock_position = 0
     OR v_reporter_lock_position <= v_target_lock_position
     OR v_auth_lock_position <= v_reporter_lock_position
     OR v_profile_lock_position <= v_auth_lock_position
     OR pg_catalog.strpos(v_submit_source, 'FOR SHARE') <=
       v_auth_lock_position
     OR pg_catalog.strpos(v_submit_source, 'FOR UPDATE') <=
       v_auth_lock_position
     OR pg_catalog.strpos(
       v_submit_source,
       'public.content_report_evidence_refs_valid'
     ) = 0
     OR pg_catalog.strpos(
       v_submit_source,
       'public.lock_actor_can_interact_with_post'
     ) = 0
     OR pg_catalog.strpos(v_submit_source, 'DUPLICATE_PENDING') = 0
     OR pg_catalog.strpos(
       v_submit_source,
       'ORDER BY upload_row.evidence_ref'
     ) = 0
     OR pg_catalog.strpos(v_submit_source, 'FROM storage.objects') = 0
     OR pg_catalog.strpos(
       v_submit_source,
       'WHEN unique_violation THEN'
     ) = 0
     OR pg_catalog.strpos(
       v_submit_source,
       'report evidence claim race detected'
     ) = 0
  THEN
    RAISE EXCEPTION 'submit_content_report source/lock contract drifted';
  END IF;

  SELECT function_row.prosrc
  INTO STRICT v_moderation_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_moderation_function;

  v_target_lock_position := pg_catalog.strpos(
    v_moderation_source,
    '''report-moderation:'''
  );
  v_auth_lock_position := pg_catalog.strpos(
    v_moderation_source,
    'FROM auth.users AS auth_user'
  );
  v_sanction_lock_position := pg_catalog.strpos(
    v_moderation_source,
    '''report-moderation-sanction:'''
  );
  v_profile_lock_position := pg_catalog.strpos(
    v_moderation_source,
    'FROM public.user_profiles AS actor_profile'
  );

  IF pg_catalog.md5(v_moderation_source) <>
       '50c413fbae8ce4e83b16e6c1466c5d25'
     OR pg_catalog.obj_description(
       v_moderation_function::oid,
       'pg_proc'
     ) IS DISTINCT FROM
       'atomic-report-moderation-queue:v1:'
         || pg_catalog.md5(v_moderation_source)
     OR v_target_lock_position = 0
     OR v_auth_lock_position <= v_target_lock_position
     OR v_sanction_lock_position <= v_auth_lock_position
     OR v_profile_lock_position <= v_sanction_lock_position
     OR pg_catalog.strpos(v_moderation_source, 'FOR SHARE') <=
       v_auth_lock_position
     OR pg_catalog.strpos(v_moderation_source, 'FOR UPDATE') <=
       v_auth_lock_position
     OR pg_catalog.strpos(
       v_moderation_source,
       'ORDER BY report_row.id'
     ) = 0
     OR pg_catalog.strpos(
       v_moderation_source,
       'v_next_report_status := ''dismissed'''
     ) = 0
     OR pg_catalog.strpos(
       v_moderation_source,
       'v_next_report_status := ''resolved'''
     ) = 0
     OR pg_catalog.strpos(
       v_moderation_source,
       'restore_auto_hidden'
     ) > 0
     OR pg_catalog.strpos(
       v_moderation_source,
       'INSERT INTO public.admin_logs'
     ) = 0
     OR pg_catalog.strpos(
       v_moderation_source,
       'locked_history'
     ) = 0
     OR pg_catalog.strpos(
       v_moderation_source,
       'processed report history not found'
     ) = 0
     OR pg_catalog.strpos(
       v_moderation_source,
       'latest moderation action conflicts with request'
     ) = 0
  THEN
    RAISE EXCEPTION 'atomic report moderation RPC source/lock contract drifted';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_validator_function
      AND function_row.prokind = 'f'
      AND function_row.prolang = v_sql_oid
      AND function_row.proowner = v_postgres_oid
      AND NOT function_row.prosecdef
      AND function_row.provolatile = 'i'
      AND NOT function_row.proretset
      AND function_row.prorettype = 'boolean'::pg_catalog.regtype
      AND function_row.pronargs = 2
      AND function_row.pronargdefaults = 0
      AND function_row.proargtypes::text = pg_catalog.array_to_string(ARRAY[
        'uuid'::pg_catalog.regtype,
        'text[]'::pg_catalog.regtype
      ]::oid[], ' ')
      AND function_row.proargnames = ARRAY[
        'p_reporter_id',
        'p_images'
      ]::text[]
      AND function_row.proconfig =
        ARRAY['search_path=pg_catalog, pg_temp']::text[]
      AND pg_catalog.md5(function_row.prosrc) =
        'c96971bafe2ba4146990aebcef3bb6f4'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_interaction_function
      AND function_row.prokind = 'f'
      AND function_row.prolang = v_plpgsql_oid
      AND function_row.proowner = v_postgres_oid
      AND function_row.prosecdef
      AND function_row.provolatile = 'v'
      AND NOT function_row.proretset
      AND function_row.prorettype = 'boolean'::pg_catalog.regtype
      AND function_row.pronargs = 2
      AND function_row.pronargdefaults = 0
      AND function_row.proconfig = ARRAY[
        'search_path=pg_catalog, pg_temp',
        'lock_timeout=5s'
      ]::text[]
      AND pg_catalog.md5(function_row.prosrc) =
        '2e5b80845ba4950779148dee421262b0'
  ) THEN
    RAISE EXCEPTION 'report submission dependencies changed during cutover';
  END IF;

  IF NOT pg_catalog.has_function_privilege(
    'service_role', v_validator_function, 'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'anon', v_validator_function, 'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'authenticated', v_validator_function, 'EXECUTE'
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        function_row.proacl,
        pg_catalog.acldefault('f', function_row.proowner)
      )
    ) AS acl_entry
    WHERE function_row.oid = v_validator_function
      AND acl_entry.grantee NOT IN (
        function_row.proowner,
        v_service_role_oid
      )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(function_row.proacl) AS acl_entry
    WHERE function_row.oid = v_validator_function
      AND acl_entry.grantee = v_service_role_oid
      AND (
        acl_entry.privilege_type <> 'EXECUTE'
        OR acl_entry.is_grantable
      )
  ) OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_proc AS function_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(function_row.proacl) AS acl_entry
    WHERE function_row.oid = v_validator_function
      AND acl_entry.grantee = v_service_role_oid
      AND acl_entry.privilege_type = 'EXECUTE'
      AND NOT acl_entry.is_grantable
  ) <> 1 THEN
    RAISE EXCEPTION 'report evidence validator ACL changed during cutover';
  END IF;
END
$postflight$;

COMMIT;
