-- Make pending-report deduplication a database invariant and publish one
-- service-only submission RPC. Existing report/admin routes already use the
-- service client, so the base table can be removed from browser PostgREST.
--
-- Rollout order: this migration is application-compatible and must land in
-- production before either report route switches to submit_content_report.
-- The legacy /api/report contract is intentionally not changed in this SQL
-- batch; its reason/type vocabulary must be retired in a later route cutover.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended(
    'public.content_reports:atomic-submission-boundary',
    0
  )
);

DO $preflight$
DECLARE
  v_reports regclass := pg_catalog.to_regclass('public.content_reports');
  v_relation_name text;
  v_relation regclass;
  v_invalid_columns text[];
  v_missing_roles text[];
  v_duplicate_groups bigint;
  v_expected_check text;
  v_pending_index regclass := pg_catalog.to_regclass(
    'public.uniq_content_reports_pending_reporter_content'
  );
BEGIN
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

    IF v_relation IS NULL THEN
      RAISE EXCEPTION
        'public.% must exist before report submission hardening',
        v_relation_name;
    END IF;

    IF (
      SELECT relation.relkind
      FROM pg_catalog.pg_class AS relation
      WHERE relation.oid = v_relation
    ) NOT IN ('r', 'p') THEN
      RAISE EXCEPTION
        'public.% must be a table or partitioned table',
        v_relation_name;
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
    RAISE EXCEPTION 'content report ACL roles are missing: %', v_missing_roles;
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
      'public.%I.%I (expected %s%s)',
      required_column.table_name,
      required_column.column_name,
      required_column.type_name,
      CASE WHEN required_column.required_not_null THEN ' NOT NULL' ELSE '' END
    )
    ORDER BY required_column.table_name, required_column.ordinality
  )
  INTO v_invalid_columns
  FROM (
    VALUES
      ('content_reports', 1, 'id', 'uuid', true),
      ('content_reports', 2, 'reporter_id', 'uuid', true),
      ('content_reports', 3, 'content_type', 'text', true),
      ('content_reports', 4, 'content_id', 'text', true),
      ('content_reports', 5, 'reason', 'text', true),
      ('content_reports', 6, 'description', 'text', false),
      ('content_reports', 7, 'images', 'text[]', false),
      ('content_reports', 8, 'status', 'text', true),
      ('content_reports', 9, 'created_at', 'timestamp with time zone', false),
      ('posts', 1, 'id', 'uuid', true),
      ('posts', 2, 'author_id', 'uuid', true),
      ('comments', 1, 'id', 'uuid', true),
      ('comments', 2, 'post_id', 'uuid', true),
      ('comments', 3, 'user_id', 'uuid', true),
      ('comments', 4, 'deleted_at', 'timestamp with time zone', false),
      ('conversations', 1, 'id', 'uuid', true),
      ('conversations', 2, 'user1_id', 'uuid', true),
      ('conversations', 3, 'user2_id', 'uuid', true),
      ('user_profiles', 1, 'id', 'uuid', true),
      ('user_profiles', 2, 'banned_at', 'timestamp with time zone', false),
      ('user_profiles', 3, 'deleted_at', 'timestamp with time zone', false)
  ) AS required_column(
    table_name,
    ordinality,
    column_name,
    type_name,
    required_not_null
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
     OR (required_column.required_not_null AND NOT attribute.attnotnull);

  IF v_invalid_columns IS NOT NULL THEN
    RAISE EXCEPTION
      'content report boundary has missing or incompatible columns: %',
      v_invalid_columns;
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
    WHERE attribute.attrelid = v_reports
      AND attribute.attname = 'status'
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  ) IS DISTINCT FROM '''pending''::text' OR (
    SELECT pg_catalog.pg_get_expr(
      column_default.adbin,
      column_default.adrelid,
      true
    )
    FROM pg_catalog.pg_attribute AS attribute
    JOIN pg_catalog.pg_attrdef AS column_default
      ON column_default.adrelid = attribute.attrelid
     AND column_default.adnum = attribute.attnum
    WHERE attribute.attrelid = v_reports
      AND attribute.attname = 'images'
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  ) IS DISTINCT FROM 'ARRAY[]::text[]' THEN
    RAISE EXCEPTION
      'content_reports status/images defaults are incompatible';
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
      WHERE constraint_row.conrelid = v_reports
        AND constraint_row.contype = 'c'
        AND constraint_row.convalidated
        AND pg_catalog.pg_get_expr(
          constraint_row.conbin,
          constraint_row.conrelid,
          true
        ) = v_expected_check
    ) THEN
      RAISE EXCEPTION
        'content_reports is missing canonical check constraint: %',
        v_expected_check;
    END IF;
  END LOOP;

  -- Validate primary lookup keys semantically rather than trusting names.
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
      RAISE EXCEPTION 'public.% requires a valid unique (id) key', v_relation_name;
    END IF;
  END LOOP;

  -- Never discard moderation evidence silently. An environment containing
  -- concurrent pending duplicates needs an explicit operator decision before
  -- this invariant can be installed.
  SELECT pg_catalog.count(*)
  INTO v_duplicate_groups
  FROM (
    SELECT 1
    FROM public.content_reports AS report_row
    WHERE report_row.status = 'pending'
    GROUP BY
      report_row.reporter_id,
      report_row.content_type,
      report_row.content_id
    HAVING pg_catalog.count(*) > 1
  ) AS duplicate_group;

  IF v_duplicate_groups > 0 THEN
    RAISE EXCEPTION
      'content_reports has % duplicate pending reporter/content groups',
      v_duplicate_groups;
  END IF;

  IF v_pending_index IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index AS index_metadata
    WHERE index_metadata.indexrelid = v_pending_index
      AND index_metadata.indrelid = v_reports
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
  ) THEN
    RAISE EXCEPTION
      'uniq_content_reports_pending_reporter_content has an incompatible definition';
  END IF;
END
$preflight$;

LOCK TABLE public.content_reports IN ACCESS EXCLUSIVE MODE;
LOCK TABLE public.posts,
  public.comments,
  public.conversations,
  public.user_profiles
  IN ACCESS SHARE MODE;

CREATE UNIQUE INDEX IF NOT EXISTS
  uniq_content_reports_pending_reporter_content
  ON public.content_reports (reporter_id, content_type, content_id)
  WHERE status = 'pending';

ALTER TABLE public.content_reports ENABLE ROW LEVEL SECURITY;

DO $revoke_nonowner_report_table_access$
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
    WHERE relation.oid = 'public.content_reports'::regclass
      AND acl_entry.grantee <> relation.relowner
  LOOP
    IF v_grantee.grantee = 0 THEN
      REVOKE ALL PRIVILEGES ON TABLE public.content_reports FROM PUBLIC;
    ELSIF v_grantee.rolname IS NOT NULL THEN
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON TABLE public.content_reports FROM %I',
        v_grantee.rolname
      );
    END IF;
  END LOOP;
END
$revoke_nonowner_report_table_access$;

REVOKE ALL PRIVILEGES ON TABLE public.content_reports
  FROM PUBLIC, anon, authenticated, service_role;

DO $revoke_column_privileges$
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
  WHERE attribute.attrelid = 'public.content_reports'::regclass
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;

  IF v_column_list IS NULL THEN
    RAISE EXCEPTION 'public.content_reports has no columns to secure';
  END IF;

  FOR v_grantee IN
    SELECT DISTINCT acl_entry.grantee, role_row.rolname
    FROM pg_catalog.pg_attribute AS attribute
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl_entry
    LEFT JOIN pg_catalog.pg_roles AS role_row
      ON role_row.oid = acl_entry.grantee
    WHERE attribute.attrelid = 'public.content_reports'::regclass
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND acl_entry.grantee <> (
        SELECT relation.relowner
        FROM pg_catalog.pg_class AS relation
        WHERE relation.oid = 'public.content_reports'::regclass
      )
  LOOP
    IF v_grantee.grantee = 0 THEN
      EXECUTE pg_catalog.format(
        'REVOKE SELECT (%1$s), INSERT (%1$s), UPDATE (%1$s), REFERENCES (%1$s) '
          || 'ON TABLE public.content_reports FROM PUBLIC',
        v_column_list
      );
    ELSIF v_grantee.rolname IS NOT NULL THEN
      EXECUTE pg_catalog.format(
        'REVOKE SELECT (%1$s), INSERT (%1$s), UPDATE (%1$s), REFERENCES (%1$s) '
          || 'ON TABLE public.content_reports FROM %2$I',
        v_column_list,
        v_grantee.rolname
      );
    END IF;
  END LOOP;

  EXECUTE pg_catalog.format(
    'REVOKE SELECT (%1$s), INSERT (%1$s), UPDATE (%1$s), REFERENCES (%1$s) '
      || 'ON TABLE public.content_reports '
      || 'FROM PUBLIC, anon, authenticated, service_role',
    v_column_list
  );
END
$revoke_column_privileges$;

DO $drop_report_policies$
DECLARE
  v_policy_name name;
BEGIN
  FOR v_policy_name IN
    SELECT policy.polname
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.content_reports'::regclass
    ORDER BY policy.polname
  LOOP
    EXECUTE pg_catalog.format(
      'DROP POLICY %I ON public.content_reports',
      v_policy_name
    );
  END LOOP;
END
$drop_report_policies$;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.content_reports
  TO service_role;

CREATE POLICY "Service role manages content reports"
  ON public.content_reports
  AS PERMISSIVE
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

DO $drop_legacy_submit_content_report$
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
$drop_legacy_submit_content_report$;

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
  v_report_id uuid;
  v_target_author_id uuid;
  v_parent_post_id uuid;
  v_user1_id uuid;
  v_user2_id uuid;
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
     OR p_images IS NULL
     OR pg_catalog.cardinality(p_images) NOT BETWEEN 1 AND 4
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'invalid content report input';
  END IF;

  FOREACH v_image IN ARRAY p_images
  LOOP
    IF v_image IS NULL
       OR pg_catalog.char_length(v_image) NOT BETWEEN 1 AND 2048
       OR v_image !~ '^https://[^[:space:]]+$'
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '22023',
        MESSAGE = 'invalid content report evidence URL';
    END IF;
  END LOOP;

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

  -- Serialize canonical callers for one reporter/target. The unique partial
  -- index remains the final defense against legacy/direct service inserts.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'content-report:'
        || p_reporter_id::text
        || ':' || p_content_type
        || ':' || p_content_id::text,
      0
    )
  );

  SELECT report_row.id
  INTO v_report_id
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
      'reason', 'DUPLICATE_PENDING'
    );
  END IF;

  CASE p_content_type
    WHEN 'post' THEN
      SELECT post_row.author_id
      INTO v_target_author_id
      FROM public.posts AS post_row
      WHERE post_row.id = p_content_id
      FOR SHARE;

      IF NOT FOUND OR v_target_author_id = p_reporter_id OR NOT
        public.lock_actor_can_interact_with_post(p_content_id, p_reporter_id)
      THEN
        RAISE EXCEPTION USING
          ERRCODE = '42501',
          MESSAGE = 'report target is unavailable';
      END IF;

    WHEN 'comment' THEN
      SELECT comment_row.user_id, comment_row.post_id
      INTO v_target_author_id, v_parent_post_id
      FROM public.comments AS comment_row
      WHERE comment_row.id = p_content_id
        AND comment_row.deleted_at IS NULL
      FOR SHARE;

      IF NOT FOUND
         OR v_target_author_id = p_reporter_id
         OR NOT public.lock_actor_can_interact_with_post(
           v_parent_post_id,
           p_reporter_id
         )
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
    RETURNING id INTO v_report_id;
  EXCEPTION
    WHEN unique_violation THEN
      -- A legacy direct service insert does not share our advisory lock. The
      -- partial unique index still turns that race into a stable duplicate.
      SELECT report_row.id
      INTO v_report_id
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
        'reason', 'DUPLICATE_PENDING'
      );
  END;

  RETURN pg_catalog.jsonb_build_object(
    'created', true,
    'report_id', v_report_id,
    'status', 'pending'
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
  v_relation regclass := 'public.content_reports'::regclass;
  v_function regprocedure :=
    'public.submit_content_report(uuid,text,uuid,text,text,text[])'::regprocedure;
  v_role name;
  v_privilege text;
  v_column name;
  v_service_role_oid oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'service_role'
  );
  v_postgres_role_oid oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'postgres'
  );
BEGIN
  IF NOT (
    SELECT relation.relrowsecurity
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = v_relation
  ) THEN
    RAISE EXCEPTION 'RLS is not enabled on public.content_reports';
  END IF;

  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated']::name[]
  LOOP
    FOREACH v_privilege IN ARRAY ARRAY[
      'SELECT', 'INSERT', 'UPDATE', 'DELETE',
      'TRUNCATE', 'REFERENCES', 'TRIGGER'
    ]::text[]
    LOOP
      IF pg_catalog.has_table_privilege(v_role, v_relation, v_privilege) THEN
        RAISE EXCEPTION
          '% still has % on public.content_reports',
          v_role,
          v_privilege;
      END IF;
    END LOOP;

    FOR v_column IN
      SELECT attribute.attname
      FROM pg_catalog.pg_attribute AS attribute
      WHERE attribute.attrelid = v_relation
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
      ORDER BY attribute.attnum
    LOOP
      FOREACH v_privilege IN ARRAY ARRAY[
        'SELECT', 'INSERT', 'UPDATE', 'REFERENCES'
      ]::text[]
      LOOP
        IF pg_catalog.has_column_privilege(
          v_role,
          v_relation,
          v_column,
          v_privilege
        ) THEN
          RAISE EXCEPTION
            '% still has column % on public.content_reports.%',
            v_role,
            v_privilege,
            v_column;
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
    WHERE relation.oid = v_relation
      AND acl_entry.grantee = 0::oid
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl_entry
    WHERE attribute.attrelid = v_relation
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND acl_entry.grantee IN (
        0::oid,
        (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'anon'),
        (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'authenticated'),
        v_service_role_oid
      )
  ) THEN
    RAISE EXCEPTION
      'application-role direct or column ACL remains on public.content_reports';
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
    WHERE relation.oid = v_relation
      AND acl_entry.grantee NOT IN (relation.relowner, v_service_role_oid)
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(relation.relacl) AS acl_entry
    WHERE relation.oid = v_relation
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
    WHERE relation.oid = v_relation
      AND acl_entry.grantee = v_service_role_oid
  ) IS DISTINCT FROM ARRAY['DELETE', 'INSERT', 'SELECT', 'UPDATE']::text[] THEN
    RAISE EXCEPTION 'content report table ACL is not exact service CRUD';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    JOIN pg_catalog.pg_class AS relation
      ON relation.oid = attribute.attrelid
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl_entry
    WHERE attribute.attrelid = v_relation
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND acl_entry.grantee <> relation.relowner
  ) THEN
    RAISE EXCEPTION 'nonowner column ACL remains on public.content_reports';
  END IF;

  FOREACH v_privilege IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']::text[]
  LOOP
    IF NOT pg_catalog.has_table_privilege(
      'service_role',
      v_relation,
      v_privilege
    ) THEN
      RAISE EXCEPTION
        'service_role is missing % on public.content_reports',
        v_privilege;
    END IF;
  END LOOP;

  FOREACH v_privilege IN ARRAY ARRAY['TRUNCATE', 'REFERENCES', 'TRIGGER']::text[]
  LOOP
    IF pg_catalog.has_table_privilege(
      'service_role',
      v_relation,
      v_privilege
    ) THEN
      RAISE EXCEPTION
        'service_role unexpectedly has % on public.content_reports',
        v_privilege;
    END IF;
  END LOOP;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = v_relation
  ) <> 1 OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = v_relation
      AND policy.polname = 'Service role manages content reports'
      AND policy.polpermissive
      AND policy.polcmd = '*'
      AND policy.polroles = ARRAY[v_service_role_oid]::oid[]
      AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid) = 'true'
      AND pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid) = 'true'
  ) THEN
    RAISE EXCEPTION
      'content report RLS policies did not converge to service-only ALL';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index AS index_metadata
    WHERE index_metadata.indexrelid =
      'public.uniq_content_reports_pending_reporter_content'::regclass
      AND index_metadata.indrelid = v_relation
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
  ) THEN
    RAISE EXCEPTION 'pending content report unique index contract is invalid';
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
    WHERE function_row.oid = v_function
      AND function_row.prosecdef
      AND function_row.proowner = v_postgres_role_oid
      AND function_row.prokind = 'f'
      AND NOT function_row.proretset
      AND function_row.provolatile = 'v'
      AND function_row.prorettype = 'jsonb'::regtype
      AND function_row.pronargdefaults = 2
      AND function_row.proargnames = ARRAY[
        'p_reporter_id',
        'p_content_type',
        'p_content_id',
        'p_reason',
        'p_description',
        'p_images'
      ]::text[]
      AND function_row.proconfig =
        ARRAY['search_path=pg_catalog, pg_temp']::text[]
  ) THEN
    RAISE EXCEPTION 'submit_content_report function contract is invalid';
  END IF;

  IF pg_catalog.has_function_privilege(
    'anon', v_function, 'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'authenticated', v_function, 'EXECUTE'
  ) OR NOT pg_catalog.has_function_privilege(
    'service_role', v_function, 'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'submit_content_report EXECUTE ACL is invalid';
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
    WHERE function_row.oid = v_function
      AND acl_entry.grantee = 0::oid
  ) THEN
    RAISE EXCEPTION 'PUBLIC can execute submit_content_report';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
