-- Make single-report triage one database transaction. The retired route could
-- hard-delete content, fail to transition the report, and then omit its audit
-- log. This boundary shares the queue/submission target lock, performs only
-- canonical soft deletion, transitions exactly one immutable report binding,
-- and records the audit row in the same transaction.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('atomic-single-report-resolution:v1', 0)
);

DO $preflight$
DECLARE
  v_relation_name text;
  v_relation pg_catalog.regclass;
  v_invalid_columns text[];
  v_resolution_function pg_catalog.regprocedure := pg_catalog.to_regprocedure(
    'public.resolve_content_report_atomic(uuid,uuid,text,text)'
  );
  v_queue_function pg_catalog.regprocedure := pg_catalog.to_regprocedure(
    'public.moderate_report_queue_atomic(uuid,text,uuid,text,uuid)'
  );
  v_comment_function pg_catalog.regprocedure := pg_catalog.to_regprocedure(
    'public.moderate_comment(uuid,uuid,text,text)'
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
  v_source text;
BEGIN
  IF v_postgres_oid IS NULL
     OR v_service_role_oid IS NULL
     OR v_plpgsql_oid IS NULL
  THEN
    RAISE EXCEPTION 'postgres, service_role, and plpgsql must exist';
  END IF;

  FOREACH v_relation_name IN ARRAY ARRAY[
    'admin_logs',
    'comments',
    'content_reports',
    'posts',
    'user_profiles'
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
        'public.% must be an ordinary permanent non-partition table',
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
      ('content_reports', 1, 'id', 'uuid', true),
      ('content_reports', 2, 'reporter_id', 'uuid', true),
      ('content_reports', 3, 'content_type', 'text', true),
      ('content_reports', 4, 'content_id', 'text', true),
      ('content_reports', 5, 'status', 'text', true),
      ('content_reports', 6, 'resolved_by', 'uuid', false),
      ('content_reports', 7, 'resolved_at', 'timestamp with time zone', false),
      ('content_reports', 8, 'action_taken', 'text', false),
      ('posts', 1, 'id', 'uuid', true),
      ('posts', 2, 'author_id', 'uuid', true),
      ('posts', 3, 'deleted_at', 'timestamp with time zone', false),
      ('posts', 4, 'deleted_by', 'uuid', false),
      ('posts', 5, 'delete_reason', 'text', false),
      ('user_profiles', 1, 'id', 'uuid', true),
      ('user_profiles', 2, 'role', 'text', false),
      ('user_profiles', 3, 'banned_at', 'timestamp with time zone', false),
      ('user_profiles', 4, 'deleted_at', 'timestamp with time zone', false)
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
     OR (required_column.is_not_null AND NOT attribute.attnotnull)
     OR attribute.attgenerated <> '';

  IF v_invalid_columns IS NOT NULL THEN
    RAISE EXCEPTION
      'single report resolution schema is incompatible: %',
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
      ) = 'status = ANY (ARRAY[''pending''::text, ''resolved''::text, ''dismissed''::text])'
  ) OR NOT EXISTS (
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
      ) = 'content_type = ANY (ARRAY[''post''::text, ''comment''::text, ''message''::text, ''user''::text])'
  ) THEN
    RAISE EXCEPTION 'canonical content report CHECK constraints drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.content_reports AS report_row
    WHERE report_row.content_id !~
      '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ) THEN
    RAISE EXCEPTION 'content_reports contains a noncanonical UUID binding';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('public.user_profiles', 'id', 'auth.users', 'id', 'c'::"char"),
        ('public.content_reports', 'reporter_id', 'auth.users', 'id', 'c'::"char"),
        ('public.content_reports', 'resolved_by', 'auth.users', 'id', 'n'::"char"),
        ('public.admin_logs', 'admin_id', 'auth.users', 'id', 'c'::"char"),
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
    RAISE EXCEPTION 'single report resolution FK authority drifted';
  END IF;

  IF v_queue_function IS NULL OR v_comment_function IS NULL THEN
    RAISE EXCEPTION
      'atomic queue moderation and canonical comment moderation must exist first';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_queue_function
      AND function_row.prokind = 'f'
      AND function_row.prolang = v_plpgsql_oid
      AND function_row.proowner = v_postgres_oid
      AND function_row.prosecdef
      AND function_row.provolatile = 'v'
      AND function_row.proretset
      AND function_row.prorettype = 'record'::pg_catalog.regtype
      AND function_row.pronargs = 5
      AND function_row.pronargdefaults = 0
      AND function_row.proargtypes::text = pg_catalog.array_to_string(ARRAY[
        'uuid'::pg_catalog.regtype,
        'text'::pg_catalog.regtype,
        'uuid'::pg_catalog.regtype,
        'text'::pg_catalog.regtype,
        'uuid'::pg_catalog.regtype
      ]::oid[], ' ')
      AND function_row.proargnames = ARRAY[
        'p_actor_id',
        'p_content_type',
        'p_content_id',
        'p_action',
        'p_operation_id',
        'applied',
        'result_operation_id',
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
      AND pg_catalog.md5(function_row.prosrc) =
        '4796e70c1a1d65b6ce16ff9359f6fcf6'
      AND pg_catalog.obj_description(function_row.oid, 'pg_proc') =
        'report-moderation-operation-id:v1:'
          || pg_catalog.md5(function_row.prosrc)
  ) THEN
    RAISE EXCEPTION 'atomic queue moderation dependency drifted';
  END IF;

  IF pg_catalog.to_regprocedure(
    'public.moderate_report_queue_atomic(uuid,text,uuid,text)'
  ) IS NOT NULL THEN
    RAISE EXCEPTION 'retired four-argument queue boundary is still executable';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_comment_function
      AND function_row.prokind = 'f'
      AND function_row.prolang = v_plpgsql_oid
      AND function_row.proowner = v_postgres_oid
      AND function_row.prosecdef
      AND function_row.provolatile = 'v'
      AND function_row.proretset
      AND function_row.prorettype = 'record'::pg_catalog.regtype
      AND function_row.pronargs = 4
      AND function_row.pronargdefaults = 1
  ) THEN
    RAISE EXCEPTION 'canonical comment moderation dependency drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        (
          'trg_comments_00_guard_canonical_mutation',
          'public.guard_canonical_comment_mutation()',
          31
        ),
        (
          'trg_comments_10_cascade_soft_delete',
          'public.cascade_comment_soft_delete()',
          17
        )
    ) AS expected_trigger(trigger_name, function_name, trigger_type)
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_trigger AS trigger_row
      WHERE trigger_row.tgrelid = 'public.comments'::pg_catalog.regclass
        AND trigger_row.tgname = expected_trigger.trigger_name
        AND trigger_row.tgfoid =
          pg_catalog.to_regprocedure(expected_trigger.function_name)
        AND trigger_row.tgtype = expected_trigger.trigger_type
        AND trigger_row.tgenabled = 'O'
        AND NOT trigger_row.tgisinternal
        AND trigger_row.tgconstraint = 0
        AND trigger_row.tgnargs = 0
        AND trigger_row.tgqual IS NULL
    )
  ) THEN
    RAISE EXCEPTION 'canonical comment moderation trigger contract drifted';
  END IF;

  IF NOT pg_catalog.has_function_privilege(
    'service_role', v_queue_function, 'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'anon', v_queue_function, 'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'authenticated', v_queue_function, 'EXECUTE'
  ) OR NOT pg_catalog.has_function_privilege(
    'service_role', v_comment_function, 'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'anon', v_comment_function, 'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'authenticated', v_comment_function, 'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'moderation dependency ACL drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_namespace AS function_schema
      ON function_schema.oid = function_row.pronamespace
    WHERE function_schema.nspname = 'public'
      AND function_row.proname = 'resolve_content_report_atomic'
      AND (
        v_resolution_function IS NULL
        OR function_row.oid <> v_resolution_function
      )
  ) THEN
    RAISE EXCEPTION 'unexpected resolve_content_report_atomic overload exists';
  END IF;

  IF v_resolution_function IS NOT NULL THEN
    SELECT function_row.prosrc
    INTO STRICT v_source
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_resolution_function;

    IF pg_catalog.obj_description(
         v_resolution_function::oid,
         'pg_proc'
       ) IS DISTINCT FROM
         'atomic-single-report-resolution:v1:' || pg_catalog.md5(v_source)
    THEN
      RAISE EXCEPTION 'replayed report resolution RPC source seal drifted';
    END IF;
  END IF;
END
$preflight$;

-- Stabilize the dependency schema in hard-delete parent -> child order.
LOCK TABLE auth.users IN SHARE MODE;
LOCK TABLE public.user_profiles,
  public.posts,
  public.comments,
  public.content_reports,
  public.admin_logs
  IN SHARE ROW EXCLUSIVE MODE;

CREATE OR REPLACE FUNCTION public.resolve_content_report_atomic(
  p_actor_id uuid,
  p_report_id uuid,
  p_action text,
  p_reason text
)
RETURNS TABLE (
  applied boolean,
  result_action text,
  result_code text,
  report_id uuid,
  report_status text,
  content_type text,
  content_id uuid,
  action_taken text,
  content_soft_deleted boolean,
  content_affected_count integer,
  admin_log_id uuid
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_audit_action text;
  v_audit_affected_count integer;
  v_audit_affected_text text;
  v_audit_author_id uuid;
  v_audit_author_text text;
  v_audit_details jsonb;
  v_audit_id uuid;
  v_audit_ids uuid[] := ARRAY[]::uuid[];
  v_audit_keys text[];
  v_audit_report_count integer;
  v_audit_report_count_text text;
  v_audit_report_ids uuid[] := ARRAY[]::uuid[];
  v_audit_soft_deleted boolean;
  v_audit_strike_id_text text;
  v_audit_strike_type text;
  v_audit_target_id uuid;
  v_audit_target_type text;
  v_auth_user_id uuid;
  v_batch_report_ids uuid[] := ARRAY[]::uuid[];
  v_batch_report_row_count integer;
  v_batch_resolved_at_count integer;
  v_candidate_author_id uuid;
  v_candidate_content_id_text text;
  v_candidate_content_type text;
  v_candidate_parent_author_id uuid;
  v_candidate_post_id uuid;
  v_candidate_reporter_id uuid;
  v_candidate_status text;
  v_comment_affected_count integer;
  v_comment_count integer;
  v_comment_post_id uuid;
  v_content_exists boolean := false;
  v_content_id uuid;
  v_locked_auth_ids uuid[] := ARRAY[]::uuid[];
  v_locked_author_id uuid;
  v_locked_content_id_text text;
  v_locked_content_type text;
  v_locked_deleted_at timestamptz;
  v_locked_parent_author_id uuid;
  v_locked_post_id uuid;
  v_locked_report_action text;
  v_locked_report_resolved_at timestamptz;
  v_locked_report_resolved_by uuid;
  v_locked_report_status text;
  v_locked_reporter_id uuid;
  v_now timestamptz;
  v_parent_exists boolean := false;
  v_reason text;
  v_report_update_count integer;
  v_required_auth_ids uuid[] := ARRAY[]::uuid[];
  v_result_action_taken text;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'service role required';
  END IF;

  v_reason := NULLIF(pg_catalog.btrim(p_reason), '');
  IF p_actor_id IS NULL
     OR p_report_id IS NULL
     OR p_action IS NULL
     OR p_action NOT IN ('resolve', 'dismiss')
     OR (
       p_reason IS NOT NULL
       AND v_reason IS NOT NULL
       AND pg_catalog.char_length(v_reason) > 500
     )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'invalid single report resolution input';
  END IF;

  -- Discover the immutable binding without a row lock. This read is not a
  -- business lock; the target advisory below is the first linearization lock.
  SELECT
    report_row.reporter_id,
    report_row.content_type,
    report_row.content_id,
    report_row.status
  INTO
    v_candidate_reporter_id,
    v_candidate_content_type,
    v_candidate_content_id_text,
    v_candidate_status
  FROM public.content_reports AS report_row
  WHERE report_row.id = p_report_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0002',
      MESSAGE = 'report not found';
  END IF;

  IF v_candidate_content_type NOT IN ('post', 'comment', 'message', 'user')
     OR v_candidate_content_id_text !~
       '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'report content binding is invalid';
  END IF;
  v_content_id := v_candidate_content_id_text::uuid;

  -- This exact key is shared by submit_content_report and queue moderation.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'report-moderation:'
        || v_candidate_content_type
        || ':' || v_content_id::text,
      0
    )
  );

  -- Discover every touched auth parent without child row locks. They are then
  -- locked globally by UUID before actor/profile/content/report children.
  IF v_candidate_content_type = 'post' THEN
    SELECT post_row.author_id
    INTO v_candidate_author_id
    FROM public.posts AS post_row
    WHERE post_row.id = v_content_id;
    v_content_exists := FOUND;
  ELSIF v_candidate_content_type = 'comment' THEN
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
    WHERE comment_row.id = v_content_id;
    v_content_exists := FOUND;

    IF v_content_exists AND v_candidate_post_id IS NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23503',
        MESSAGE = 'reported comment parent binding is invalid';
    END IF;
  END IF;

  SELECT pg_catalog.array_agg(required_id ORDER BY required_id)
  INTO STRICT v_required_auth_ids
  FROM (
    SELECT DISTINCT required_id
    FROM pg_catalog.unnest(ARRAY[
      p_actor_id,
      v_candidate_reporter_id,
      v_candidate_author_id,
      v_candidate_parent_author_id
    ]::uuid[]) AS required_auth(required_id)
    WHERE required_id IS NOT NULL
  ) AS required_auth_identity;

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

  IF NOT v_candidate_reporter_id = ANY (v_locked_auth_ids) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0002',
      MESSAGE = 'reporter identity is unavailable';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.unnest(v_required_auth_ids) AS required_auth(required_id)
    WHERE NOT required_id = ANY (v_locked_auth_ids)
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'reported content identity is unavailable';
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

  IF v_candidate_content_type = 'post' AND v_content_exists THEN
    SELECT post_row.author_id, post_row.deleted_at
    INTO v_locked_author_id, v_locked_deleted_at
    FROM public.posts AS post_row
    WHERE post_row.id = v_content_id
    FOR UPDATE;

    IF NOT FOUND THEN
      v_content_exists := false;
      v_locked_author_id := NULL;
      v_locked_deleted_at := NULL;
    ELSIF v_locked_author_id IS DISTINCT FROM v_candidate_author_id THEN
      RAISE EXCEPTION USING
        ERRCODE = '40001',
        MESSAGE = 'reported post identity changed during resolution';
    END IF;
  ELSIF v_candidate_content_type = 'comment' AND v_content_exists THEN
    SELECT parent_post.author_id
    INTO v_locked_parent_author_id
    FROM public.posts AS parent_post
    WHERE parent_post.id = v_candidate_post_id
    FOR UPDATE;
    v_parent_exists := FOUND;

    SELECT
      comment_row.post_id,
      comment_row.user_id,
      comment_row.deleted_at
    INTO
      v_locked_post_id,
      v_locked_author_id,
      v_locked_deleted_at
    FROM public.comments AS comment_row
    WHERE comment_row.id = v_content_id
    FOR UPDATE;

    IF NOT FOUND THEN
      v_content_exists := false;
      v_locked_author_id := NULL;
      v_locked_deleted_at := NULL;
    ELSIF NOT v_parent_exists
       OR v_locked_post_id IS DISTINCT FROM v_candidate_post_id
       OR v_locked_author_id IS DISTINCT FROM v_candidate_author_id
       OR v_locked_parent_author_id IS DISTINCT FROM v_candidate_parent_author_id
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '40001',
        MESSAGE = 'reported comment identity changed during resolution';
    END IF;
  ELSIF NOT v_content_exists AND v_candidate_content_type = 'post' AND EXISTS (
    SELECT 1 FROM public.posts AS appeared_post WHERE appeared_post.id = v_content_id
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'reported post appeared during resolution';
  ELSIF NOT v_content_exists AND v_candidate_content_type = 'comment' AND EXISTS (
    SELECT 1 FROM public.comments AS appeared_comment WHERE appeared_comment.id = v_content_id
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'reported comment appeared during resolution';
  END IF;

  SELECT
    report_row.reporter_id,
    report_row.content_type,
    report_row.content_id,
    report_row.status,
    report_row.action_taken,
    report_row.resolved_by,
    report_row.resolved_at
  INTO
    v_locked_reporter_id,
    v_locked_content_type,
    v_locked_content_id_text,
    v_locked_report_status,
    v_locked_report_action,
    v_locked_report_resolved_by,
    v_locked_report_resolved_at
  FROM public.content_reports AS report_row
  WHERE report_row.id = p_report_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0002',
      MESSAGE = 'report not found';
  END IF;

  IF v_locked_reporter_id IS DISTINCT FROM v_candidate_reporter_id
     OR v_locked_content_type IS DISTINCT FROM v_candidate_content_type
     OR v_locked_content_id_text IS DISTINCT FROM v_candidate_content_id_text
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'report content binding changed during resolution';
  END IF;

  result_action := p_action;
  report_id := p_report_id;
  report_status := v_locked_report_status;
  content_type := v_candidate_content_type;
  content_id := v_content_id;
  content_affected_count := 0;
  admin_log_id := NULL;

  IF p_action = 'resolve'
     AND v_candidate_content_type NOT IN ('post', 'comment')
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '0A000',
      MESSAGE = 'report content type cannot be resolved by this endpoint';
  END IF;

  IF v_locked_report_status <> 'pending' THEN
    IF v_locked_report_resolved_by IS DISTINCT FROM p_actor_id
       OR v_locked_report_resolved_at IS NULL
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '40001',
        MESSAGE = 'processed report actor evidence conflicts with this retry';
    END IF;

    -- A report status is not idempotency evidence by itself. Lock the one
    -- exact atomic audit that either this single-report RPC or the sealed queue
    -- RPC committed with the report. Missing, duplicate, or forged evidence is
    -- a conflict and never authorizes a successful no-op acknowledgement.
    SELECT COALESCE(
      pg_catalog.array_agg(locked_audit.id ORDER BY locked_audit.id),
      ARRAY[]::uuid[]
    )
    INTO v_audit_ids
    FROM (
      SELECT audit_row.id
      FROM public.admin_logs AS audit_row
      WHERE audit_row.admin_id = p_actor_id
        AND (
          (
            audit_row.target_type = 'report'
            AND audit_row.target_id = p_report_id
            AND audit_row.details -> 'report_id' =
              pg_catalog.to_jsonb(p_report_id)
          )
          OR (
            pg_catalog.jsonb_typeof(audit_row.details -> 'report_ids') = 'array'
            AND (audit_row.details -> 'report_ids') ? p_report_id::text
          )
        )
      ORDER BY audit_row.id
      FOR SHARE
    ) AS locked_audit;

    IF pg_catalog.cardinality(v_audit_ids) <> 1 THEN
      RAISE EXCEPTION USING
        ERRCODE = '40001',
        MESSAGE = 'exact atomic report audit evidence is missing';
    END IF;
    v_audit_id := v_audit_ids[1];

    SELECT
      audit_row.action,
      audit_row.target_type,
      audit_row.target_id,
      audit_row.details
    INTO STRICT
      v_audit_action,
      v_audit_target_type,
      v_audit_target_id,
      v_audit_details
    FROM public.admin_logs AS audit_row
    WHERE audit_row.id = v_audit_id;

    IF pg_catalog.jsonb_typeof(v_audit_details) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION USING
        ERRCODE = '40001',
        MESSAGE = 'atomic report audit object is malformed';
    END IF;

    SELECT pg_catalog.array_agg(detail_key ORDER BY detail_key)
    INTO STRICT v_audit_keys
    FROM pg_catalog.jsonb_object_keys(v_audit_details) AS keys(detail_key);

    v_audit_affected_text := v_audit_details ->> 'content_affected_count';
    IF pg_catalog.jsonb_typeof(
         v_audit_details -> 'content_affected_count'
       ) IS DISTINCT FROM 'number'
       OR v_audit_affected_text IS NULL
       OR v_audit_affected_text !~ '^[0-9]+$'
       OR pg_catalog.char_length(v_audit_affected_text) > 10
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '40001',
        MESSAGE = 'atomic report audit affected count is malformed';
    END IF;
    IF v_audit_affected_text::bigint > 2147483647 THEN
      RAISE EXCEPTION USING
        ERRCODE = '40001',
        MESSAGE = 'atomic report audit affected count is out of range';
    END IF;
    v_audit_affected_count := v_audit_affected_text::integer;

    IF v_audit_keys = ARRAY[
      'action_taken',
      'content_affected_count',
      'content_id',
      'content_soft_deleted',
      'content_type',
      'reason',
      'report_id',
      'report_status',
      'resolved_at'
    ]::text[] THEN
      IF v_audit_details -> 'content_soft_deleted' = 'true'::jsonb THEN
        v_audit_soft_deleted := true;
      ELSIF v_audit_details -> 'content_soft_deleted' = 'null'::jsonb THEN
        v_audit_soft_deleted := NULL;
      ELSE
        RAISE EXCEPTION USING
          ERRCODE = '40001',
          MESSAGE = 'single report audit soft-delete evidence is malformed';
      END IF;

      IF v_audit_action IS DISTINCT FROM (
           CASE p_action
             WHEN 'resolve' THEN 'resolve_report'
             ELSE 'dismiss_report'
           END
         )
         OR v_audit_target_type IS DISTINCT FROM 'report'
         OR v_audit_target_id IS DISTINCT FROM p_report_id
         OR v_audit_details -> 'report_id' IS DISTINCT FROM
           pg_catalog.to_jsonb(p_report_id)
         OR v_audit_details -> 'report_status' IS DISTINCT FROM
           pg_catalog.to_jsonb(v_locked_report_status)
         OR v_audit_details -> 'content_type' IS DISTINCT FROM
           pg_catalog.to_jsonb(v_candidate_content_type)
         OR v_audit_details -> 'content_id' IS DISTINCT FROM
           pg_catalog.to_jsonb(v_content_id)
         OR v_audit_details -> 'action_taken' IS DISTINCT FROM
           pg_catalog.to_jsonb(v_locked_report_action)
         OR v_audit_details -> 'resolved_at' IS DISTINCT FROM
           pg_catalog.to_jsonb(v_locked_report_resolved_at)
         OR v_audit_details -> 'reason' IS DISTINCT FROM COALESCE(
           pg_catalog.to_jsonb(v_reason),
           'null'::jsonb
         )
      THEN
        RAISE EXCEPTION USING
          ERRCODE = '40001',
          MESSAGE = 'single report audit binding conflicts with this retry';
      END IF;

      IF (
        p_action = 'dismiss'
        AND (
          v_locked_report_status <> 'dismissed'
          OR v_locked_report_action <> 'dismissed'
          OR v_audit_soft_deleted IS NOT NULL
          OR v_audit_affected_count <> 0
        )
      ) OR (
        p_action = 'resolve'
        AND (
          v_locked_report_status <> 'resolved'
          OR v_locked_report_action NOT IN (
            'content_deleted',
            'content_already_absent'
          )
          OR (
            v_locked_report_action = 'content_deleted'
            AND (
              v_audit_soft_deleted IS NOT TRUE
              OR v_audit_affected_count < 1
              OR (
                v_candidate_content_type = 'post'
                AND v_audit_affected_count <> 1
              )
            )
          )
          OR (
            v_locked_report_action = 'content_already_absent'
            AND (
              v_audit_affected_count <> 0
              OR (
                v_audit_soft_deleted IS NOT TRUE
                AND v_audit_soft_deleted IS NOT NULL
              )
            )
          )
        )
      ) THEN
        RAISE EXCEPTION USING
          ERRCODE = '40001',
          MESSAGE = 'single report audit effect is not equivalent';
      END IF;
    ELSIF v_audit_keys = ARRAY[
      'action_taken',
      'author_id',
      'content_affected_count',
      'content_id',
      'content_type',
      'report_count',
      'report_ids',
      'report_status',
      'strike_id',
      'strike_type'
    ]::text[] THEN
      IF v_reason IS NOT NULL
         OR pg_catalog.jsonb_typeof(v_audit_details -> 'report_ids')
           IS DISTINCT FROM 'array'
      THEN
        RAISE EXCEPTION USING
          ERRCODE = '40001',
          MESSAGE = 'queue audit report batch is malformed';
      END IF;

      IF EXISTS (
        SELECT 1
        FROM pg_catalog.jsonb_array_elements_text(
          v_audit_details -> 'report_ids'
        ) AS audit_report(report_id_text)
        WHERE audit_report.report_id_text IS NULL
          OR audit_report.report_id_text !~*
            '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      ) THEN
        RAISE EXCEPTION USING
          ERRCODE = '40001',
          MESSAGE = 'queue audit report batch is malformed';
      END IF;

      SELECT COALESCE(
        pg_catalog.array_agg(
          audit_report.report_id_text::uuid
          ORDER BY audit_report.report_id_text::uuid
        ),
        ARRAY[]::uuid[]
      )
      INTO v_audit_report_ids
      FROM pg_catalog.jsonb_array_elements_text(
        v_audit_details -> 'report_ids'
      ) AS audit_report(report_id_text);

      v_audit_report_count_text := v_audit_details ->> 'report_count';
      IF pg_catalog.jsonb_typeof(v_audit_details -> 'report_count')
           IS DISTINCT FROM 'number'
         OR v_audit_report_count_text IS NULL
         OR v_audit_report_count_text !~ '^[1-9][0-9]*$'
         OR pg_catalog.char_length(v_audit_report_count_text) > 10
      THEN
        RAISE EXCEPTION USING
          ERRCODE = '40001',
          MESSAGE = 'queue audit report count is malformed';
      END IF;
      IF v_audit_report_count_text::bigint > 2147483647 THEN
        RAISE EXCEPTION USING
          ERRCODE = '40001',
          MESSAGE = 'queue audit report count is out of range';
      END IF;
      v_audit_report_count := v_audit_report_count_text::integer;

      IF pg_catalog.cardinality(v_audit_report_ids) <> v_audit_report_count
         OR v_audit_details -> 'report_ids' IS DISTINCT FROM
           pg_catalog.to_jsonb(v_audit_report_ids)
         OR NOT p_report_id = ANY (v_audit_report_ids)
         OR v_audit_details -> 'content_type' IS DISTINCT FROM
           pg_catalog.to_jsonb(v_candidate_content_type)
         OR v_audit_details -> 'content_id' IS DISTINCT FROM
           pg_catalog.to_jsonb(v_content_id)
         OR v_audit_details -> 'report_status' IS DISTINCT FROM
           pg_catalog.to_jsonb(v_locked_report_status)
         OR v_audit_details -> 'action_taken' IS DISTINCT FROM
           pg_catalog.to_jsonb(v_locked_report_action)
      THEN
        RAISE EXCEPTION USING
          ERRCODE = '40001',
          MESSAGE = 'queue audit binding conflicts with this report';
      END IF;

      SELECT
        COALESCE(
          pg_catalog.array_agg(
            batch_report.id ORDER BY batch_report.id
          ),
          ARRAY[]::uuid[]
        ),
        pg_catalog.count(*)::integer,
        pg_catalog.count(DISTINCT batch_report.resolved_at)::integer
      INTO
        v_batch_report_ids,
        v_batch_report_row_count,
        v_batch_resolved_at_count
      FROM (
        SELECT
          locked_batch_report.id,
          locked_batch_report.resolved_at
        FROM public.content_reports AS locked_batch_report
        WHERE locked_batch_report.id = ANY (v_audit_report_ids)
        ORDER BY locked_batch_report.id
        FOR SHARE
      ) AS batch_report;

      IF v_batch_report_ids IS DISTINCT FROM v_audit_report_ids
         OR v_batch_report_row_count <> v_audit_report_count
         OR v_batch_resolved_at_count <> 1
         OR EXISTS (
           SELECT 1
           FROM public.content_reports AS batch_report
           WHERE batch_report.id = ANY (v_audit_report_ids)
             AND (
               batch_report.content_type IS DISTINCT FROM
                 v_candidate_content_type
               OR batch_report.content_id IS DISTINCT FROM
                 v_candidate_content_id_text
               OR batch_report.status IS DISTINCT FROM
                 v_locked_report_status
               OR batch_report.action_taken IS DISTINCT FROM
                 v_locked_report_action
               OR batch_report.resolved_by IS DISTINCT FROM p_actor_id
               OR batch_report.resolved_at IS NULL
             )
         )
      THEN
        RAISE EXCEPTION USING
          ERRCODE = '40001',
          MESSAGE = 'queue audit report rows no longer match the atomic batch';
      END IF;

      SELECT COALESCE(
        pg_catalog.array_agg(batch_report.id ORDER BY batch_report.id),
        ARRAY[]::uuid[]
      )
      INTO v_batch_report_ids
      FROM (
        SELECT locked_batch_report.id
        FROM public.content_reports AS locked_batch_report
        WHERE locked_batch_report.content_type = v_candidate_content_type
          AND locked_batch_report.content_id = v_candidate_content_id_text
          AND locked_batch_report.resolved_at = v_locked_report_resolved_at
        ORDER BY locked_batch_report.id
        FOR SHARE
      ) AS batch_report;

      IF v_batch_report_ids IS DISTINCT FROM v_audit_report_ids THEN
        RAISE EXCEPTION USING
          ERRCODE = '40001',
          MESSAGE = 'queue audit does not cover the exact atomic report batch';
      END IF;

      v_audit_author_text := v_audit_details ->> 'author_id';
      v_audit_strike_id_text := v_audit_details ->> 'strike_id';
      v_audit_strike_type := v_audit_details ->> 'strike_type';
      IF (v_audit_author_text IS NOT NULL AND v_audit_author_text !~*
            '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
         OR v_audit_strike_id_text IS NOT NULL
         OR v_audit_strike_type IS NOT NULL
      THEN
        RAISE EXCEPTION USING
          ERRCODE = '40001',
          MESSAGE = 'queue audit effect identity is malformed';
      END IF;
      v_audit_author_id := v_audit_author_text::uuid;

      IF v_audit_author_id IS DISTINCT FROM (
           CASE
             WHEN v_content_exists THEN v_locked_author_id
             ELSE NULL::uuid
           END
         )
         OR (
           v_locked_report_action = 'approved_content'
           AND (
             p_action <> 'dismiss'
             OR v_locked_report_status <> 'dismissed'
             OR v_audit_action <> 'dismiss_reports'
             OR v_audit_target_type <> v_candidate_content_type
             OR v_audit_target_id IS DISTINCT FROM v_content_id
             OR v_audit_affected_count <> 0
           )
         )
         OR (
           v_locked_report_action IN (
             'content_deleted',
             'content_already_absent'
           )
           AND (
             p_action <> 'resolve'
             OR v_locked_report_status <> 'resolved'
             OR v_audit_action <> 'delete_content'
             OR v_audit_target_type <> v_candidate_content_type
             OR v_audit_target_id IS DISTINCT FROM v_content_id
             OR (
               v_locked_report_action = 'content_deleted'
               AND v_audit_affected_count < 1
             )
             OR (
               v_candidate_content_type = 'post'
               AND v_locked_report_action = 'content_deleted'
               AND v_audit_affected_count <> 1
             )
             OR (
               v_locked_report_action = 'content_already_absent'
               AND v_audit_affected_count <> 0
             )
           )
         )
         OR (
           v_locked_report_action = 'user_banned'
           AND (
             p_action <> 'resolve'
             OR v_locked_report_status <> 'resolved'
             OR v_audit_action <> 'ban_user_from_queue'
             OR v_audit_target_type <> 'user'
             OR v_audit_author_id IS NULL
             OR v_audit_target_id IS DISTINCT FROM v_audit_author_id
             OR v_audit_affected_count < 1
             OR (
               v_candidate_content_type = 'post'
               AND v_audit_affected_count <> 1
             )
           )
         )
         OR v_locked_report_action NOT IN (
           'approved_content',
           'content_deleted',
           'content_already_absent',
           'user_banned'
         )
      THEN
        RAISE EXCEPTION USING
          ERRCODE = '40001',
          MESSAGE = 'queue audit effect is not equivalent to this retry';
      END IF;
    ELSE
      RAISE EXCEPTION USING
        ERRCODE = '40001',
        MESSAGE = 'atomic report audit key contract is invalid';
    END IF;

    IF p_action = 'resolve'
       AND v_locked_report_action IN (
         'content_deleted',
         'content_already_absent',
         'user_banned'
       )
       AND v_content_exists
       AND v_locked_deleted_at IS NULL
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '40001',
        MESSAGE = 'destructive audit evidence conflicts with active content';
    END IF;

    applied := false;
    result_code := 'already_processed';
    action_taken := v_locked_report_action;
    content_soft_deleted := CASE
      WHEN p_action = 'dismiss' THEN NULL
      WHEN v_content_exists THEN true
      ELSE NULL
    END;
    admin_log_id := v_audit_id;
    RETURN NEXT;
    RETURN;
  END IF;

  v_now := pg_catalog.clock_timestamp();

  IF p_action = 'dismiss' THEN
    report_status := 'dismissed';
    v_result_action_taken := 'dismissed';
    content_soft_deleted := NULL;
  ELSE
    report_status := 'resolved';
    content_soft_deleted := CASE
      WHEN v_content_exists THEN v_locked_deleted_at IS NOT NULL
      ELSE NULL
    END;

    IF NOT v_content_exists OR v_locked_deleted_at IS NOT NULL THEN
      v_result_action_taken := 'content_already_absent';
    ELSIF v_candidate_content_type = 'post' THEN
      UPDATE public.posts AS moderated_post
      SET deleted_at = v_now,
          deleted_by = p_actor_id,
          delete_reason = COALESCE(v_reason, 'Report resolved by moderator')
      WHERE moderated_post.id = v_content_id
        AND moderated_post.author_id IS NOT DISTINCT FROM v_candidate_author_id
        AND moderated_post.deleted_at IS NULL;
      GET DIAGNOSTICS content_affected_count = ROW_COUNT;

      IF content_affected_count <> 1 THEN
        RAISE EXCEPTION USING
          ERRCODE = '40001',
          MESSAGE = 'active post soft-delete acknowledgement is invalid';
      END IF;
      v_result_action_taken := 'content_deleted';
      content_soft_deleted := true;
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
        v_content_id,
        p_actor_id,
        'soft_delete',
        COALESCE(v_reason, 'Report resolved by moderator')
      ) AS moderation_result;

      IF NOT FOUND
         OR v_comment_post_id IS DISTINCT FROM v_candidate_post_id
         OR v_comment_affected_count < 1
         OR v_comment_count < 0
      THEN
        RAISE EXCEPTION USING
          ERRCODE = '40001',
          MESSAGE = 'active comment soft-delete acknowledgement is invalid';
      END IF;

      content_affected_count := v_comment_affected_count;
      v_result_action_taken := 'content_deleted';
      content_soft_deleted := true;
    END IF;
  END IF;

  UPDATE public.content_reports AS transitioned_report
  SET status = report_status,
      resolved_by = p_actor_id,
      resolved_at = v_now,
      action_taken = v_result_action_taken
  WHERE transitioned_report.id = p_report_id
    AND transitioned_report.reporter_id = v_candidate_reporter_id
    AND transitioned_report.status = 'pending'
    AND transitioned_report.content_type = v_candidate_content_type
    AND transitioned_report.content_id = v_candidate_content_id_text;
  GET DIAGNOSTICS v_report_update_count = ROW_COUNT;

  IF v_report_update_count <> 1 THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'single pending report transition race detected';
  END IF;

  INSERT INTO public.admin_logs (
    admin_id,
    action,
    target_type,
    target_id,
    details
  ) VALUES (
    p_actor_id,
    CASE WHEN p_action = 'resolve' THEN 'resolve_report' ELSE 'dismiss_report' END,
    'report',
    p_report_id,
    pg_catalog.jsonb_build_object(
      'report_id', p_report_id,
      'report_status', report_status,
      'content_type', v_candidate_content_type,
      'content_id', v_content_id,
      'action_taken', v_result_action_taken,
      'content_soft_deleted', content_soft_deleted,
      'content_affected_count', content_affected_count,
      'reason', v_reason,
      'resolved_at', v_now
    )
  )
  RETURNING id INTO admin_log_id;

  IF admin_log_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'admin audit acknowledgement is invalid';
  END IF;

  applied := true;
  result_code := 'applied';
  action_taken := v_result_action_taken;
  RETURN NEXT;
END
$function$;

ALTER FUNCTION public.resolve_content_report_atomic(uuid, uuid, text, text)
  OWNER TO postgres;

REVOKE ALL ON FUNCTION public.resolve_content_report_atomic(uuid, uuid, text, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.resolve_content_report_atomic(uuid, uuid, text, text)
  TO service_role;

DO $seal_function$
DECLARE
  v_function pg_catalog.regprocedure :=
    'public.resolve_content_report_atomic(uuid,uuid,text,text)'::pg_catalog.regprocedure;
  v_digest text;
BEGIN
  SELECT pg_catalog.md5(function_row.prosrc)
  INTO STRICT v_digest
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_function;

  EXECUTE pg_catalog.format(
    'COMMENT ON FUNCTION %s IS %L',
    v_function,
    'atomic-single-report-resolution:v1:' || v_digest
  );
END
$seal_function$;

DO $postflight$
DECLARE
  v_function pg_catalog.regprocedure :=
    'public.resolve_content_report_atomic(uuid,uuid,text,text)'::pg_catalog.regprocedure;
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
  v_source text;
  v_target_lock_position integer;
  v_auth_lock_position integer;
  v_profile_lock_position integer;
  v_content_lock_position integer;
  v_report_lock_position integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_function
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
        'uuid'::pg_catalog.regtype,
        'text'::pg_catalog.regtype,
        'text'::pg_catalog.regtype
      ]::oid[], ' ')
      AND function_row.proallargtypes = ARRAY[
        'uuid'::pg_catalog.regtype,
        'uuid'::pg_catalog.regtype,
        'text'::pg_catalog.regtype,
        'text'::pg_catalog.regtype,
        'boolean'::pg_catalog.regtype,
        'text'::pg_catalog.regtype,
        'text'::pg_catalog.regtype,
        'uuid'::pg_catalog.regtype,
        'text'::pg_catalog.regtype,
        'text'::pg_catalog.regtype,
        'uuid'::pg_catalog.regtype,
        'text'::pg_catalog.regtype,
        'boolean'::pg_catalog.regtype,
        'integer'::pg_catalog.regtype,
        'uuid'::pg_catalog.regtype
      ]::oid[]
      AND function_row.proargmodes = ARRAY[
        'i'::"char", 'i'::"char", 'i'::"char", 'i'::"char",
        't'::"char", 't'::"char", 't'::"char", 't'::"char",
        't'::"char", 't'::"char", 't'::"char", 't'::"char",
        't'::"char", 't'::"char", 't'::"char"
      ]::"char"[]
      AND function_row.proargnames = ARRAY[
        'p_actor_id',
        'p_report_id',
        'p_action',
        'p_reason',
        'applied',
        'result_action',
        'result_code',
        'report_id',
        'report_status',
        'content_type',
        'content_id',
        'action_taken',
        'content_soft_deleted',
        'content_affected_count',
        'admin_log_id'
      ]::text[]
      AND function_row.proconfig = ARRAY[
        'search_path=pg_catalog, pg_temp',
        'lock_timeout=5s'
      ]::text[]
  ) THEN
    RAISE EXCEPTION 'atomic single report resolution metadata drifted';
  END IF;

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
    CROSS JOIN LATERAL pg_catalog.aclexplode(function_row.proacl) AS acl_entry
    WHERE function_row.oid = v_function
      AND acl_entry.grantee = v_service_role_oid
      AND (
        acl_entry.privilege_type <> 'EXECUTE'
        OR acl_entry.is_grantable
      )
  ) OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_proc AS function_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(function_row.proacl) AS acl_entry
    WHERE function_row.oid = v_function
      AND acl_entry.grantee = v_service_role_oid
      AND acl_entry.privilege_type = 'EXECUTE'
      AND NOT acl_entry.is_grantable
  ) <> 1 THEN
    RAISE EXCEPTION 'atomic single report resolution ACL drifted';
  END IF;

  SELECT function_row.prosrc
  INTO STRICT v_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_function;

  v_target_lock_position := pg_catalog.strpos(
    v_source,
    '''report-moderation:'''
  );
  v_auth_lock_position := pg_catalog.strpos(
    v_source,
    'FROM auth.users AS auth_user'
  );
  v_profile_lock_position := pg_catalog.strpos(
    v_source,
    'FROM public.user_profiles AS actor_profile'
  );
  v_content_lock_position := pg_catalog.strpos(
    v_source,
    'FROM public.posts AS post_row'
  );
  v_report_lock_position := pg_catalog.strpos(
    v_source,
    'FROM public.content_reports AS report_row'
  );

  IF pg_catalog.obj_description(v_function::oid, 'pg_proc') IS DISTINCT FROM
       'atomic-single-report-resolution:v1:' || pg_catalog.md5(v_source)
     OR v_target_lock_position = 0
     OR v_auth_lock_position <= v_target_lock_position
     OR v_profile_lock_position <= v_auth_lock_position
     OR pg_catalog.strpos(v_source, 'ORDER BY auth_user.id') = 0
     OR pg_catalog.strpos(v_source, '''soft_delete''') = 0
     OR pg_catalog.strpos(v_source, 'INSERT INTO public.admin_logs') = 0
     OR pg_catalog.strpos(v_source, 'content_already_absent') = 0
     OR pg_catalog.strpos(
       v_source,
       'exact atomic report audit evidence is missing'
     ) = 0
     OR pg_catalog.strpos(v_source, '''resolved_at'', v_now') = 0
     OR v_content_lock_position = 0
     OR v_report_lock_position = 0
  THEN
    RAISE EXCEPTION 'atomic single report resolution source/lock contract drifted';
  END IF;
END
$postflight$;

COMMIT;
