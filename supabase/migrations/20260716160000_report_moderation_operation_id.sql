-- Give every moderation-queue write a caller-owned UUID operation identity.
-- The durable ledger makes a lost response replay independent of mutable report
-- history, while the wrapper locks every auth/profile identity in UUID order
-- before taking a profile/content child lock. The sealed v1 implementation is
-- retained only as an owner-only implementation detail.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('report-moderation-operation-id:v1', 0)
);

DO $preflight$
DECLARE
  v_old pg_catalog.regprocedure := pg_catalog.to_regprocedure(
    'public.moderate_report_queue_atomic(uuid,text,uuid,text)'
  );
  v_internal pg_catalog.regprocedure := pg_catalog.to_regprocedure(
    'public.moderate_report_queue_atomic_v1_internal(uuid,text,uuid,text)'
  );
  v_new pg_catalog.regprocedure := pg_catalog.to_regprocedure(
    'public.moderate_report_queue_atomic(uuid,text,uuid,text,uuid)'
  );
  v_ledger pg_catalog.regclass := pg_catalog.to_regclass(
    'public.report_moderation_operations'
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

  IF v_old IS NOT NULL THEN
    IF v_internal IS NOT NULL OR v_new IS NOT NULL OR v_ledger IS NOT NULL THEN
      RAISE EXCEPTION 'partial report moderation operation-id cutover detected';
    END IF;

    SELECT function_row.prosrc
    INTO STRICT v_source
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_old
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
      AND function_row.proargnames[1:4] = ARRAY[
        'p_actor_id',
        'p_content_type',
        'p_content_id',
        'p_action'
      ]::text[]
      AND function_row.proconfig = ARRAY[
        'search_path=pg_catalog, pg_temp',
        'lock_timeout=5s'
      ]::text[];

    IF pg_catalog.md5(v_source) <> '50c413fbae8ce4e83b16e6c1466c5d25'
       OR pg_catalog.obj_description(v_old::oid, 'pg_proc') IS DISTINCT FROM
         'atomic-report-moderation-queue:v1:' || pg_catalog.md5(v_source)
       OR NOT pg_catalog.has_function_privilege(
         'service_role', v_old, 'EXECUTE'
       )
       OR pg_catalog.has_function_privilege('anon', v_old, 'EXECUTE')
       OR pg_catalog.has_function_privilege(
         'authenticated', v_old, 'EXECUTE'
       )
    THEN
      RAISE EXCEPTION 'sealed four-argument moderation dependency drifted';
    END IF;
  ELSIF v_internal IS NOT NULL AND v_new IS NOT NULL AND v_ledger IS NOT NULL THEN
    SELECT function_row.prosrc
    INTO STRICT v_source
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_internal
      AND function_row.proowner = v_postgres_oid
      AND function_row.prosecdef
      AND function_row.proconfig = ARRAY[
        'search_path=pg_catalog, pg_temp',
        'lock_timeout=5s'
      ]::text[];

    IF pg_catalog.md5(v_source) <> '50c413fbae8ce4e83b16e6c1466c5d25'
       OR pg_catalog.obj_description(v_internal::oid, 'pg_proc') IS DISTINCT FROM
         'report-moderation-operation-id:internal-v1:' || pg_catalog.md5(v_source)
       OR pg_catalog.has_function_privilege(
         'service_role', v_internal, 'EXECUTE'
       )
       OR pg_catalog.has_function_privilege('anon', v_internal, 'EXECUTE')
       OR pg_catalog.has_function_privilege(
         'authenticated', v_internal, 'EXECUTE'
       )
       OR EXISTS (
         SELECT 1
         FROM pg_catalog.pg_proc AS function_row
         CROSS JOIN LATERAL pg_catalog.aclexplode(
           COALESCE(
             function_row.proacl,
             pg_catalog.acldefault('f', function_row.proowner)
           )
         ) AS acl_entry
         WHERE function_row.oid = v_internal
           AND acl_entry.grantee <> function_row.proowner
       )
    THEN
      RAISE EXCEPTION 'owner-only moderation implementation drifted';
    END IF;

    SELECT function_row.prosrc
    INTO STRICT v_source
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_new
      AND function_row.proowner = v_postgres_oid
      AND function_row.prosecdef
      AND function_row.proconfig = ARRAY[
        'search_path=pg_catalog, pg_temp',
        'lock_timeout=5s'
      ]::text[];

    IF pg_catalog.md5(v_source) <> '4796e70c1a1d65b6ce16ff9359f6fcf6'
       OR pg_catalog.obj_description(v_new::oid, 'pg_proc') IS DISTINCT FROM
         'report-moderation-operation-id:v1:' || pg_catalog.md5(v_source)
       OR NOT pg_catalog.has_function_privilege(
         'service_role', v_new, 'EXECUTE'
       )
       OR pg_catalog.has_function_privilege('anon', v_new, 'EXECUTE')
       OR pg_catalog.has_function_privilege(
         'authenticated', v_new, 'EXECUTE'
       )
    THEN
      RAISE EXCEPTION 'operation-id moderation wrapper drifted';
    END IF;

    IF (
      SELECT NOT relation.relrowsecurity
        OR relation.relforcerowsecurity
        OR relation.relkind <> 'r'
        OR relation.relpersistence <> 'p'
        OR relation.relispartition
        OR relation.relreplident <> 'd'
        OR relation.relowner <> v_postgres_oid
      FROM pg_catalog.pg_class AS relation
      WHERE relation.oid = v_ledger
    ) OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_policy AS policy_row
      WHERE policy_row.polrelid = v_ledger
    ) OR pg_catalog.has_table_privilege(
      'service_role', v_ledger, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
    ) OR pg_catalog.has_table_privilege(
      'anon', v_ledger, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
    ) OR pg_catalog.has_table_privilege(
      'authenticated', v_ledger, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
    ) OR pg_catalog.obj_description(v_ledger::oid, 'pg_class') IS DISTINCT FROM
      'Owner-only permanent idempotency ledger for moderation-queue operation UUIDs; actor IDs intentionally have no deletion-cascading foreign key.'
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_inherits AS inheritance
      WHERE inheritance.inhrelid = v_ledger
         OR inheritance.inhparent = v_ledger
    ) OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_rewrite AS rewrite_rule
      WHERE rewrite_rule.ev_class = v_ledger
    ) OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_policy AS policy_row
      WHERE policy_row.polrelid = v_ledger
    ) OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_trigger AS trigger_row
      WHERE trigger_row.tgrelid = v_ledger
    ) OR (
      SELECT pg_catalog.count(*)
      FROM pg_catalog.pg_attribute AS attribute
      WHERE attribute.attrelid = v_ledger
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
    ) <> 16 OR EXISTS (
      SELECT 1
      FROM (
        VALUES
          (1, 'operation_id', 'uuid', true, false, ''),
          (2, 'actor_id', 'uuid', true, false, ''),
          (3, 'content_type', 'text', true, false, ''),
          (4, 'content_id', 'uuid', true, false, ''),
          (5, 'action', 'text', true, false, ''),
          (6, 'report_ids', 'uuid[]', true, false, ''),
          (7, 'report_status', 'text', true, false, ''),
          (8, 'report_count', 'integer', true, false, ''),
          (9, 'action_taken', 'text', true, false, ''),
          (10, 'author_id', 'uuid', false, false, ''),
          (11, 'content_soft_deleted', 'boolean', false, false, ''),
          (12, 'initial_applied', 'boolean', true, false, ''),
          (13, 'initial_content_affected_count', 'integer', true, false, ''),
          (14, 'initial_strike_id', 'uuid', false, false, ''),
          (15, 'initial_strike_type', 'text', false, false, ''),
          (
            16,
            'created_at',
            'timestamp with time zone',
            true,
            true,
            'clock_timestamp()'
          )
      ) AS expected_column(
        attnum,
        attname,
        type_name,
        is_not_null,
        has_default,
        default_expression
      )
      LEFT JOIN pg_catalog.pg_attribute AS attribute
        ON attribute.attrelid = v_ledger
       AND attribute.attnum = expected_column.attnum
       AND NOT attribute.attisdropped
      LEFT JOIN pg_catalog.pg_attrdef AS default_row
        ON default_row.adrelid = attribute.attrelid
       AND default_row.adnum = attribute.attnum
      WHERE attribute.attname IS NULL
         OR attribute.attname <> expected_column.attname
         OR pg_catalog.format_type(
           attribute.atttypid,
           attribute.atttypmod
         ) <> expected_column.type_name
         OR attribute.attnotnull <> expected_column.is_not_null
         OR attribute.atthasdef <> expected_column.has_default
         OR attribute.attidentity <> ''
         OR attribute.attgenerated <> ''
         OR COALESCE(
           pg_catalog.pg_get_expr(
             default_row.adbin,
             default_row.adrelid,
             true
           ),
           ''
         ) <> expected_column.default_expression
    ) OR (
      SELECT pg_catalog.count(*)
      FROM pg_catalog.pg_constraint AS constraint_row
      WHERE constraint_row.conrelid = v_ledger
    ) <> 6 OR EXISTS (
      SELECT 1
      FROM (
        VALUES
          (
            'report_moderation_operations_action_check',
            'c'::"char",
            'd55ec29b10fc5aefa18bc6a99c1dfe9d'
          ),
          (
            'report_moderation_operations_content_type_check',
            'c'::"char",
            'f9c35d1b4d6c60522d4384f56dc910a6'
          ),
          (
            'report_moderation_operations_decision_check',
            'c'::"char",
            '98527cba3591c8cec79527eaadfde4b3'
          ),
          (
            'report_moderation_operations_pkey',
            'p'::"char",
            'f59b9d798d6d843ea6ea10575b2ae406'
          ),
          (
            'report_moderation_operations_report_batch_check',
            'c'::"char",
            '472bcb5bca83af97040b4b0df551ca6d'
          ),
          (
            'report_moderation_operations_result_check',
            'c'::"char",
            'a2c739be6df5d2a8416abf333dd5fa8c'
          )
      ) AS expected_constraint(constraint_name, constraint_type, expression_digest)
      LEFT JOIN pg_catalog.pg_constraint AS constraint_row
        ON constraint_row.conrelid = v_ledger
       AND constraint_row.conname = expected_constraint.constraint_name
      WHERE constraint_row.oid IS NULL
         OR constraint_row.contype <> expected_constraint.constraint_type
         OR NOT constraint_row.convalidated
         OR constraint_row.condeferrable
         OR constraint_row.condeferred
         OR constraint_row.conparentid <> 0
         OR (
           expected_constraint.constraint_type = 'c'::"char"
           AND constraint_row.connoinherit
         )
         OR pg_catalog.md5(COALESCE(
           pg_catalog.pg_get_expr(
             constraint_row.conbin,
             constraint_row.conrelid,
             true
           ),
           pg_catalog.pg_get_constraintdef(constraint_row.oid, true)
         )) <> expected_constraint.expression_digest
    ) OR (
      SELECT pg_catalog.count(*)
      FROM pg_catalog.pg_index AS index_row
      JOIN pg_catalog.pg_class AS index_relation
        ON index_relation.oid = index_row.indexrelid
      JOIN pg_catalog.pg_am AS access_method
        ON access_method.oid = index_relation.relam
      WHERE index_row.indrelid = v_ledger
    ) <> 1 OR NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_index AS index_row
      JOIN pg_catalog.pg_class AS index_relation
        ON index_relation.oid = index_row.indexrelid
      JOIN pg_catalog.pg_am AS access_method
        ON access_method.oid = index_relation.relam
      WHERE index_row.indrelid = v_ledger
        AND index_row.indexrelid = pg_catalog.to_regclass(
          'public.report_moderation_operations_pkey'
        )
        AND index_row.indisunique
        AND index_row.indisprimary
        AND index_row.indisvalid
        AND index_row.indisready
        AND index_row.indimmediate
        AND NOT index_row.indisexclusion
        AND NOT index_row.indisclustered
        AND NOT index_row.indisreplident
        AND index_row.indpred IS NULL
        AND index_row.indexprs IS NULL
        AND index_row.indnkeyatts = 1
        AND index_row.indnatts = 1
        AND index_row.indkey[0] = 1
        AND index_relation.relkind = 'i'
        AND index_relation.relpersistence = 'p'
        AND index_relation.relowner = v_postgres_oid
        AND index_relation.reloptions IS NULL
        AND access_method.amname = 'btree'
    ) OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS relation
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          relation.relacl,
          pg_catalog.acldefault('r', relation.relowner)
        )
      ) AS acl_entry
      WHERE relation.oid = v_ledger
        AND acl_entry.grantee <> relation.relowner
    ) OR (
      SELECT pg_catalog.array_agg(
        acl_entry.privilege_type ORDER BY acl_entry.privilege_type
      )
      FROM pg_catalog.pg_class AS relation
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          relation.relacl,
          pg_catalog.acldefault('r', relation.relowner)
        )
      ) AS acl_entry
      WHERE relation.oid = v_ledger
        AND acl_entry.grantee = relation.relowner
        AND NOT acl_entry.is_grantable
    ) IS DISTINCT FROM ARRAY[
      'DELETE',
      'INSERT',
      'MAINTAIN',
      'REFERENCES',
      'SELECT',
      'TRIGGER',
      'TRUNCATE',
      'UPDATE'
    ]::text[]
    THEN
      RAISE EXCEPTION 'operation ledger relation or ACL drifted';
    END IF;
  ELSE
    RAISE EXCEPTION 'report moderation operation-id prerequisites are incompatible';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_namespace AS function_schema
      ON function_schema.oid = function_row.pronamespace
    WHERE function_schema.nspname = 'public'
      AND function_row.proname = 'moderate_report_queue_atomic'
  ) <> 1 OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_namespace AS function_schema
      ON function_schema.oid = function_row.pronamespace
    WHERE function_schema.nspname = 'public'
      AND function_row.proname = 'moderate_report_queue_atomic_v1_internal'
  ) <> (CASE WHEN v_old IS NULL THEN 1 ELSE 0 END) THEN
    RAISE EXCEPTION 'unexpected moderation function overload inventory';
  END IF;
END
$preflight$;

CREATE TABLE IF NOT EXISTS public.report_moderation_operations (
  operation_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  content_type text NOT NULL,
  content_id uuid NOT NULL,
  action text NOT NULL,
  report_ids uuid[] NOT NULL,
  report_status text NOT NULL,
  report_count integer NOT NULL,
  action_taken text NOT NULL,
  author_id uuid,
  content_soft_deleted boolean,
  initial_applied boolean NOT NULL,
  initial_content_affected_count integer NOT NULL,
  initial_strike_id uuid,
  initial_strike_type text,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CONSTRAINT report_moderation_operations_pkey PRIMARY KEY (operation_id),
  CONSTRAINT report_moderation_operations_content_type_check
    CHECK (content_type IN ('post', 'comment')),
  CONSTRAINT report_moderation_operations_action_check
    CHECK (action IN ('approve', 'delete', 'warn', 'ban')),
  CONSTRAINT report_moderation_operations_report_batch_check CHECK (
    report_count > 0
    AND report_count = pg_catalog.cardinality(report_ids)
    AND pg_catalog.array_position(report_ids, NULL::uuid) IS NULL
  ),
  CONSTRAINT report_moderation_operations_decision_check CHECK (
    (action = 'approve'
      AND report_status = 'dismissed'
      AND action_taken = 'approved_content')
    OR (action = 'delete'
      AND report_status = 'resolved'
      AND action_taken IN ('content_deleted', 'content_already_absent'))
    OR (action = 'warn'
      AND report_status = 'resolved'
      AND action_taken = 'user_warned')
    OR (action = 'ban'
      AND report_status = 'resolved'
      AND action_taken = 'user_banned')
  ),
  CONSTRAINT report_moderation_operations_result_check CHECK (
    initial_content_affected_count >= 0
    AND (
      (author_id IS NULL AND content_soft_deleted IS NULL)
      OR (author_id IS NOT NULL AND content_soft_deleted IS NOT NULL)
    )
    AND (
      (NOT initial_applied
        AND initial_content_affected_count = 0
        AND initial_strike_id IS NULL
        AND initial_strike_type IS NULL
        AND (
          action NOT IN ('delete', 'ban')
          OR content_soft_deleted IS TRUE
          OR (content_soft_deleted IS NULL AND author_id IS NULL)
        ))
      OR (initial_applied
        AND (
          (action = 'warn'
            AND author_id IS NOT NULL
            AND initial_content_affected_count = 0
            AND initial_strike_id IS NOT NULL
            AND initial_strike_type IN ('warning', 'mute', 'temp_ban', 'perm_ban'))
          OR (action = 'approve'
            AND initial_content_affected_count = 0
            AND initial_strike_id IS NULL
            AND initial_strike_type IS NULL)
          OR (action = 'delete'
            AND initial_strike_id IS NULL
            AND initial_strike_type IS NULL
            AND (
              (action_taken = 'content_deleted'
                AND content_soft_deleted IS TRUE
                AND initial_content_affected_count > 0)
              OR (action_taken = 'content_already_absent'
                AND initial_content_affected_count = 0
                AND (
                  (content_soft_deleted IS TRUE AND author_id IS NOT NULL)
                  OR (content_soft_deleted IS NULL AND author_id IS NULL)
                ))
            ))
          OR (action = 'ban'
            AND author_id IS NOT NULL
            AND content_soft_deleted IS TRUE
            AND initial_content_affected_count > 0
            AND initial_strike_id IS NULL
            AND initial_strike_type IS NULL)
        ))
    )
  )
);

COMMENT ON TABLE public.report_moderation_operations IS
  'Owner-only permanent idempotency ledger for moderation-queue operation UUIDs; actor IDs intentionally have no deletion-cascading foreign key.';

ALTER TABLE public.report_moderation_operations OWNER TO postgres;
ALTER TABLE public.report_moderation_operations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.report_moderation_operations
  FROM PUBLIC, anon, authenticated, service_role;

DO $retire_old_boundary$
BEGIN
  IF pg_catalog.to_regprocedure(
    'public.moderate_report_queue_atomic(uuid,text,uuid,text)'
  ) IS NOT NULL THEN
    EXECUTE 'ALTER FUNCTION public.moderate_report_queue_atomic(uuid, text, uuid, text) '
      || 'RENAME TO moderate_report_queue_atomic_v1_internal';
  END IF;
END
$retire_old_boundary$;

ALTER FUNCTION public.moderate_report_queue_atomic_v1_internal(
  uuid,
  text,
  uuid,
  text
) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.moderate_report_queue_atomic_v1_internal(
  uuid,
  text,
  uuid,
  text
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.moderate_report_queue_atomic(
  p_actor_id uuid,
  p_content_type text,
  p_content_id uuid,
  p_action text,
  p_operation_id uuid
)
RETURNS TABLE (
  applied boolean,
  result_operation_id uuid,
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
  v_audit_action text;
  v_audit_affected_text text;
  v_audit_author_id uuid;
  v_audit_author_text text;
  v_audit_count integer;
  v_audit_strike_id uuid;
  v_audit_strike_id_text text;
  v_audit_strike_type text;
  v_audit_target_id uuid;
  v_audit_target_type text;
  v_auth_user_id uuid;
  v_batch_action_max text;
  v_batch_action_min text;
  v_batch_report_ids uuid[] := ARRAY[]::uuid[];
  v_batch_resolved_at timestamptz;
  v_batch_resolver_id uuid;
  v_batch_resolver_variant_count integer;
  v_batch_status_max text;
  v_batch_status_min text;
  v_candidate_author_id uuid;
  v_candidate_parent_author_id uuid;
  v_candidate_post_id uuid;
  v_content_exists boolean := false;
  v_current_content_exists boolean := false;
  v_current_content_soft_deleted boolean;
  v_existing public.report_moderation_operations%ROWTYPE;
  v_initial_content_active boolean := false;
  v_locked_auth_ids uuid[] := ARRAY[]::uuid[];
  v_locked_author_id uuid;
  v_locked_deleted_at timestamptz;
  v_locked_parent_author_id uuid;
  v_locked_post_id uuid;
  v_locked_profile_ids uuid[] := ARRAY[]::uuid[];
  v_profile_id uuid;
  v_required_auth_ids uuid[] := ARRAY[]::uuid[];
  v_required_profile_ids uuid[] := ARRAY[]::uuid[];
  v_result record;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'service role required';
  END IF;

  IF p_actor_id IS NULL
     OR p_content_id IS NULL
     OR p_operation_id IS NULL
     OR p_content_type NOT IN ('post', 'comment')
     OR p_action NOT IN ('approve', 'delete', 'warn', 'ban')
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'invalid report moderation input';
  END IF;

  -- The global operation identity is the first lock. A replay or collision
  -- returns from its immutable ledger row without occupying an unrelated
  -- target lock.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'report-moderation-operation:' || p_operation_id::text,
      0
    )
  );

  SELECT operation_row.*
  INTO v_existing
  FROM public.report_moderation_operations AS operation_row
  WHERE operation_row.operation_id = p_operation_id;

  IF FOUND THEN
    IF v_existing.actor_id IS DISTINCT FROM p_actor_id
       OR v_existing.content_type IS DISTINCT FROM p_content_type
       OR v_existing.content_id IS DISTINCT FROM p_content_id
       OR v_existing.action IS DISTINCT FROM p_action
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '40001',
        MESSAGE = 'operation ID is already bound to another moderation intent';
    END IF;

    applied := v_existing.initial_applied;
    result_operation_id := p_operation_id;
    result_action := v_existing.action;
    result_content_type := v_existing.content_type;
    result_content_id := v_existing.content_id;
    report_status := v_existing.report_status;
    report_count := v_existing.report_count;
    action_taken := v_existing.action_taken;
    author_id := v_existing.author_id;
    content_soft_deleted := v_existing.content_soft_deleted;
    content_affected_count := v_existing.initial_content_affected_count;
    strike_id := v_existing.initial_strike_id;
    strike_type := v_existing.initial_strike_type;
    RETURN NEXT;
    RETURN;
  END IF;

  -- Only a new operation enters the target-scoped submit/moderation order.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'report-moderation:' || p_content_type || ':' || p_content_id::text,
      0
    )
  );

  -- Discover immutable identity candidates without taking a child lock.
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

  -- Auth parents are always first and globally UUID ordered.
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

  IF v_content_exists AND p_action IN ('warn', 'ban') THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'report-moderation-sanction:' || v_candidate_author_id::text,
        0
      )
    );
  END IF;

  SELECT pg_catalog.array_agg(required_id ORDER BY required_id)
  INTO STRICT v_required_profile_ids
  FROM (
    SELECT DISTINCT required_id
    FROM pg_catalog.unnest(
      CASE
        WHEN v_content_exists AND p_action IN ('warn', 'ban')
          THEN ARRAY[p_actor_id, v_candidate_author_id]::uuid[]
        ELSE ARRAY[p_actor_id]::uuid[]
      END
    ) AS required_profile(required_id)
    WHERE required_id IS NOT NULL
  ) AS required_profile_identity;

  -- Every profile that this action can read or mutate is locked FOR UPDATE in
  -- UUID order before the first profile/content child access. In particular,
  -- opposing A->B and B->A sanctions request [A,B] in the same order.
  FOR v_profile_id IN
    SELECT profile_row.id
    FROM public.user_profiles AS profile_row
    WHERE profile_row.id = ANY (v_required_profile_ids)
    ORDER BY profile_row.id
    FOR UPDATE
  LOOP
    v_locked_profile_ids := pg_catalog.array_append(
      v_locked_profile_ids,
      v_profile_id
    );
  END LOOP;

  PERFORM 1
  FROM public.user_profiles AS actor_profile
  WHERE actor_profile.id = p_actor_id
    AND actor_profile.role = 'admin'
    AND actor_profile.banned_at IS NULL
    AND actor_profile.deleted_at IS NULL;

  IF NOT FOUND OR NOT p_actor_id = ANY (v_locked_profile_ids) THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'active administrator profile required';
  END IF;

  IF v_content_exists
     AND p_action IN ('warn', 'ban')
     AND NOT v_candidate_author_id = ANY (v_locked_profile_ids)
  THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0002',
      MESSAGE = 'reported content author is unavailable';
  END IF;

  IF v_content_exists AND p_action IN ('warn', 'ban') THEN
    PERFORM 1
    FROM public.user_profiles AS target_profile
    WHERE target_profile.id = v_candidate_author_id
      AND target_profile.deleted_at IS NULL;

    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0002',
        MESSAGE = 'reported content author is unavailable';
    END IF;
  END IF;

  -- Only after every required profile lock is held may content children be
  -- locked. Revalidate all unlocked identity observations under those locks.
  IF p_content_type = 'post' AND v_content_exists THEN
    SELECT post_row.author_id, post_row.deleted_at
    INTO v_locked_author_id, v_locked_deleted_at
    FROM public.posts AS post_row
    WHERE post_row.id = p_content_id
    FOR UPDATE;

    IF NOT FOUND
       OR v_locked_author_id IS DISTINCT FROM v_candidate_author_id
    THEN
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
    INTO v_locked_post_id, v_locked_author_id, v_locked_deleted_at
    FROM public.comments AS comment_row
    WHERE comment_row.id = p_content_id
      AND comment_row.post_id = v_candidate_post_id
    FOR UPDATE;

    IF NOT FOUND
       OR v_locked_post_id IS DISTINCT FROM v_candidate_post_id
       OR v_locked_author_id IS DISTINCT FROM v_candidate_author_id
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '40001',
        MESSAGE = 'reported comment identity changed during moderation';
    END IF;
  ELSIF p_content_type = 'post' THEN
    PERFORM 1
    FROM public.posts AS appeared_post
    WHERE appeared_post.id = p_content_id
    FOR UPDATE;

    IF FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = '40001',
        MESSAGE = 'reported post appeared during moderation';
    END IF;
  ELSE
    PERFORM 1
    FROM public.comments AS appeared_comment
    WHERE appeared_comment.id = p_content_id
    FOR UPDATE;

    IF FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = '40001',
        MESSAGE = 'reported comment appeared during moderation';
    END IF;
  END IF;

  v_initial_content_active := v_content_exists AND v_locked_deleted_at IS NULL;

  SELECT implementation_result.*
  INTO STRICT v_result
  FROM public.moderate_report_queue_atomic_v1_internal(
    p_actor_id,
    p_content_type,
    p_content_id,
    p_action
  ) AS implementation_result;

  IF p_content_type = 'post' THEN
    SELECT post_row.deleted_at IS NOT NULL
    INTO v_current_content_soft_deleted
    FROM public.posts AS post_row
    WHERE post_row.id = p_content_id;
  ELSE
    SELECT comment_row.deleted_at IS NOT NULL
    INTO v_current_content_soft_deleted
    FROM public.comments AS comment_row
    WHERE comment_row.id = p_content_id;
  END IF;
  v_current_content_exists := FOUND;

  IF v_result.result_action IS DISTINCT FROM p_action
     OR v_result.result_content_type IS DISTINCT FROM p_content_type
     OR v_result.result_content_id IS DISTINCT FROM p_content_id
     OR v_result.report_count IS NULL
     OR v_result.report_count < 1
     OR v_result.report_status IS NULL
     OR v_result.action_taken IS NULL
     OR v_result.content_affected_count IS NULL
     OR v_result.content_affected_count < 0
     OR v_current_content_exists IS DISTINCT FROM v_content_exists
     OR (
       v_current_content_exists
       AND (
         v_result.author_id IS DISTINCT FROM v_candidate_author_id
         OR v_result.content_soft_deleted IS DISTINCT FROM
           v_current_content_soft_deleted
       )
     )
     OR (
       NOT v_current_content_exists
       AND (
         v_result.author_id IS NOT NULL
         OR v_result.content_soft_deleted IS NOT NULL
       )
     )
     OR (NOT v_result.applied AND (
       v_result.content_affected_count <> 0
       OR v_result.strike_id IS NOT NULL
       OR v_result.strike_type IS NOT NULL
     ))
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'moderation implementation acknowledgement is invalid';
  END IF;

  -- A legacy delete replay must never bless an active row merely because
  -- mutable report history says content_deleted.
  IF NOT v_result.applied
     AND p_action IN ('delete', 'ban')
     AND v_initial_content_active
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'legacy destructive evidence conflicts with active content';
  END IF;

  IF v_result.applied
     AND p_action = 'ban'
     AND (
       NOT v_initial_content_active
       OR v_result.content_affected_count < 1
     )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'ban must soft-delete active reported content';
  END IF;

  SELECT pg_catalog.max(report_row.resolved_at)
  INTO v_batch_resolved_at
  FROM public.content_reports AS report_row
  WHERE report_row.content_type = p_content_type
    AND report_row.content_id = p_content_id::text
    AND report_row.status <> 'pending';

  IF v_batch_resolved_at IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'atomic moderation report batch evidence is missing';
  END IF;

  SELECT
    COALESCE(
      pg_catalog.array_agg(report_row.id ORDER BY report_row.id),
      ARRAY[]::uuid[]
    ),
    pg_catalog.min(report_row.status),
    pg_catalog.max(report_row.status),
    pg_catalog.min(report_row.action_taken),
    pg_catalog.max(report_row.action_taken),
    (
      pg_catalog.count(DISTINCT report_row.resolved_by)
      + CASE
        WHEN pg_catalog.bool_or(report_row.resolved_by IS NULL) THEN 1
        ELSE 0
      END
    )::integer,
    (pg_catalog.array_agg(report_row.resolved_by ORDER BY report_row.id))[1]
  INTO
    v_batch_report_ids,
    v_batch_status_min,
    v_batch_status_max,
    v_batch_action_min,
    v_batch_action_max,
    v_batch_resolver_variant_count,
    v_batch_resolver_id
  FROM public.content_reports AS report_row
  WHERE report_row.content_type = p_content_type
    AND report_row.content_id = p_content_id::text
    AND report_row.resolved_at = v_batch_resolved_at;

  IF pg_catalog.cardinality(v_batch_report_ids) <> v_result.report_count
     OR v_batch_resolver_variant_count <> 1
     OR v_batch_resolver_id IS NULL
     OR v_batch_status_min IS DISTINCT FROM v_batch_status_max
     OR v_batch_action_min IS DISTINCT FROM v_batch_action_max
     OR v_batch_status_min IS DISTINCT FROM v_result.report_status
     OR v_batch_action_min IS DISTINCT FROM v_result.action_taken
     OR (v_result.applied AND v_batch_resolver_id IS DISTINCT FROM p_actor_id)
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'atomic moderation report batch evidence is inconsistent';
  END IF;

  -- Require the exact ten-key audit object emitted by the sealed atomic
  -- implementation. Matching only a report row status is not idempotency
  -- evidence: all report IDs, target, status, action, and effect must agree.
  SELECT pg_catalog.count(*)::integer
  INTO v_audit_count
  FROM public.admin_logs AS audit_row
  WHERE audit_row.admin_id = v_batch_resolver_id
    AND audit_row.details -> 'content_type' = pg_catalog.to_jsonb(p_content_type)
    AND audit_row.details -> 'content_id' = pg_catalog.to_jsonb(p_content_id)
    AND audit_row.details -> 'report_count' =
      pg_catalog.to_jsonb(v_result.report_count)
    AND audit_row.details -> 'report_ids' =
      pg_catalog.to_jsonb(v_batch_report_ids)
    AND audit_row.details -> 'report_status' =
      pg_catalog.to_jsonb(v_result.report_status)
    AND audit_row.details -> 'action_taken' =
      pg_catalog.to_jsonb(v_result.action_taken)
    AND CASE
      WHEN pg_catalog.jsonb_typeof(audit_row.details) = 'object' THEN (
        SELECT pg_catalog.array_agg(detail_key ORDER BY detail_key)
        FROM pg_catalog.jsonb_object_keys(audit_row.details) AS keys(detail_key)
      )
      ELSE ARRAY[]::text[]
    END = ARRAY[
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
    ]::text[];

  IF v_audit_count <> 1 THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'exact atomic moderation audit evidence is missing';
  END IF;

  SELECT
    audit_row.action,
    audit_row.target_type,
    audit_row.target_id,
    audit_row.details ->> 'author_id',
    audit_row.details ->> 'content_affected_count',
    audit_row.details ->> 'strike_id',
    audit_row.details ->> 'strike_type'
  INTO STRICT
    v_audit_action,
    v_audit_target_type,
    v_audit_target_id,
    v_audit_author_text,
    v_audit_affected_text,
    v_audit_strike_id_text,
    v_audit_strike_type
  FROM public.admin_logs AS audit_row
  WHERE audit_row.admin_id = v_batch_resolver_id
    AND audit_row.details -> 'content_type' = pg_catalog.to_jsonb(p_content_type)
    AND audit_row.details -> 'content_id' = pg_catalog.to_jsonb(p_content_id)
    AND audit_row.details -> 'report_count' =
      pg_catalog.to_jsonb(v_result.report_count)
    AND audit_row.details -> 'report_ids' =
      pg_catalog.to_jsonb(v_batch_report_ids)
    AND audit_row.details -> 'report_status' =
      pg_catalog.to_jsonb(v_result.report_status)
    AND audit_row.details -> 'action_taken' =
      pg_catalog.to_jsonb(v_result.action_taken)
    AND CASE
      WHEN pg_catalog.jsonb_typeof(audit_row.details) = 'object' THEN (
        SELECT pg_catalog.array_agg(detail_key ORDER BY detail_key)
        FROM pg_catalog.jsonb_object_keys(audit_row.details) AS keys(detail_key)
      )
      ELSE ARRAY[]::text[]
    END = ARRAY[
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
    ]::text[];

  IF v_audit_affected_text IS NULL
     OR v_audit_affected_text !~ '^[0-9]+$'
     OR (v_audit_author_text IS NOT NULL AND v_audit_author_text !~*
       '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
     OR (v_audit_strike_id_text IS NOT NULL AND v_audit_strike_id_text !~*
       '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'atomic moderation audit effect is malformed';
  END IF;

  IF (v_audit_affected_text::numeric) > 2147483647 THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'atomic moderation audit affected count is out of range';
  END IF;

  v_audit_author_id := v_audit_author_text::uuid;
  v_audit_strike_id := v_audit_strike_id_text::uuid;

  IF (v_current_content_exists
      AND v_audit_author_id IS DISTINCT FROM v_result.author_id)
     OR (v_result.applied AND (
       v_audit_author_id IS DISTINCT FROM v_result.author_id
       OR v_audit_affected_text::numeric IS DISTINCT FROM
         v_result.content_affected_count::numeric
       OR v_audit_strike_id IS DISTINCT FROM v_result.strike_id
       OR v_audit_strike_type IS DISTINCT FROM v_result.strike_type
     ))
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'atomic moderation audit does not match the returned effect';
  END IF;

  IF p_action = 'warn' AND NOT EXISTS (
    SELECT 1
    FROM public.user_strikes AS audited_strike
    WHERE audited_strike.id = v_audit_strike_id
      AND audited_strike.user_id = v_audit_author_id
      AND audited_strike.issued_by = v_batch_resolver_id
      AND audited_strike.strike_type = v_audit_strike_type
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'atomic moderation audit strike evidence is missing';
  END IF;

  IF (
    p_action = 'approve'
    AND (
      v_audit_action IS DISTINCT FROM 'dismiss_reports'
      OR v_audit_target_type IS DISTINCT FROM p_content_type
      OR v_audit_target_id IS DISTINCT FROM p_content_id
      OR v_audit_affected_text IS DISTINCT FROM '0'
      OR v_audit_strike_id IS NOT NULL
      OR v_audit_strike_type IS NOT NULL
    )
  ) OR (
    p_action = 'delete'
    AND (
      v_audit_action IS DISTINCT FROM 'delete_content'
      OR v_audit_target_type IS DISTINCT FROM p_content_type
      OR v_audit_target_id IS DISTINCT FROM p_content_id
      OR v_audit_strike_id IS NOT NULL
      OR v_audit_strike_type IS NOT NULL
      OR (v_result.action_taken = 'content_deleted'
        AND v_audit_affected_text::numeric < 1)
      OR (v_result.action_taken = 'content_already_absent'
        AND v_audit_affected_text IS DISTINCT FROM '0')
      OR (v_result.action_taken = 'content_deleted'
        AND v_current_content_exists
        AND NOT v_current_content_soft_deleted)
    )
  ) OR (
    p_action = 'warn'
    AND (
      v_audit_target_type IS DISTINCT FROM 'user'
      OR v_audit_target_id IS DISTINCT FROM v_result.author_id
      OR v_audit_author_id IS DISTINCT FROM v_result.author_id
      OR v_audit_affected_text IS DISTINCT FROM '0'
      OR v_audit_strike_id IS NULL
      OR v_audit_strike_type NOT IN ('warning', 'mute', 'temp_ban', 'perm_ban')
      OR v_audit_action IS DISTINCT FROM CASE v_audit_strike_type
        WHEN 'warning' THEN 'issue_warning'
        WHEN 'mute' THEN 'issue_mute'
        WHEN 'temp_ban' THEN 'issue_temp_ban'
        WHEN 'perm_ban' THEN 'issue_perm_ban'
        ELSE NULL
      END
    )
  ) OR (
    p_action = 'ban'
    AND (
      v_audit_action IS DISTINCT FROM 'ban_user_from_queue'
      OR v_audit_target_type IS DISTINCT FROM 'user'
      OR v_audit_target_id IS DISTINCT FROM v_result.author_id
      OR v_audit_author_id IS DISTINCT FROM v_result.author_id
      OR v_audit_strike_id IS NOT NULL
      OR v_audit_strike_type IS NOT NULL
      OR (v_result.applied AND (
        NOT v_initial_content_active
        OR v_audit_affected_text::numeric < 1
      ))
    )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'atomic moderation audit effect conflicts with report batch';
  END IF;

  BEGIN
    INSERT INTO public.report_moderation_operations (
      operation_id,
      actor_id,
      content_type,
      content_id,
      action,
      report_ids,
      report_status,
      report_count,
      action_taken,
      author_id,
      content_soft_deleted,
      initial_applied,
      initial_content_affected_count,
      initial_strike_id,
      initial_strike_type
    ) VALUES (
      p_operation_id,
      p_actor_id,
      p_content_type,
      p_content_id,
      p_action,
      v_batch_report_ids,
      v_result.report_status,
      v_result.report_count,
      v_result.action_taken,
      v_result.author_id,
      v_result.content_soft_deleted,
      v_result.applied,
      v_result.content_affected_count,
      v_result.strike_id,
      v_result.strike_type
    );
  EXCEPTION
    WHEN unique_violation THEN
      RAISE EXCEPTION USING
        ERRCODE = '40001',
        MESSAGE = 'operation ID collision detected';
  END;

  applied := v_result.applied;
  result_operation_id := p_operation_id;
  result_action := v_result.result_action;
  result_content_type := v_result.result_content_type;
  result_content_id := v_result.result_content_id;
  report_status := v_result.report_status;
  report_count := v_result.report_count;
  action_taken := v_result.action_taken;
  author_id := v_result.author_id;
  content_soft_deleted := v_result.content_soft_deleted;
  content_affected_count := v_result.content_affected_count;
  strike_id := v_result.strike_id;
  strike_type := v_result.strike_type;
  RETURN NEXT;
END
$function$;

ALTER FUNCTION public.moderate_report_queue_atomic(
  uuid,
  text,
  uuid,
  text,
  uuid
) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.moderate_report_queue_atomic(
  uuid,
  text,
  uuid,
  text,
  uuid
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.moderate_report_queue_atomic(
  uuid,
  text,
  uuid,
  text,
  uuid
) TO service_role;

DO $seal_functions$
DECLARE
  v_function pg_catalog.regprocedure;
  v_digest text;
  v_prefix text;
BEGIN
  FOREACH v_function IN ARRAY ARRAY[
    'public.moderate_report_queue_atomic_v1_internal(uuid,text,uuid,text)'::pg_catalog.regprocedure,
    'public.moderate_report_queue_atomic(uuid,text,uuid,text,uuid)'::pg_catalog.regprocedure
  ]::pg_catalog.regprocedure[]
  LOOP
    SELECT
      pg_catalog.md5(function_row.prosrc),
      CASE function_row.proname
        WHEN 'moderate_report_queue_atomic_v1_internal'
          THEN 'report-moderation-operation-id:internal-v1:'
        ELSE 'report-moderation-operation-id:v1:'
      END
    INTO STRICT v_digest, v_prefix
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_function;

    EXECUTE pg_catalog.format(
      'COMMENT ON FUNCTION %s IS %L',
      v_function,
      v_prefix || v_digest
    );
  END LOOP;
END
$seal_functions$;

DO $postflight$
DECLARE
  v_internal pg_catalog.regprocedure :=
    'public.moderate_report_queue_atomic_v1_internal(uuid,text,uuid,text)'::pg_catalog.regprocedure;
  v_new pg_catalog.regprocedure :=
    'public.moderate_report_queue_atomic(uuid,text,uuid,text,uuid)'::pg_catalog.regprocedure;
  v_ledger pg_catalog.regclass :=
    'public.report_moderation_operations'::pg_catalog.regclass;
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
  v_auth_lock_position integer;
  v_profile_lock_position integer;
  v_content_lock_position integer;
BEGIN
  IF pg_catalog.to_regprocedure(
    'public.moderate_report_queue_atomic(uuid,text,uuid,text)'
  ) IS NOT NULL OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_namespace AS function_schema
      ON function_schema.oid = function_row.pronamespace
    WHERE function_schema.nspname = 'public'
      AND function_row.proname = 'moderate_report_queue_atomic'
  ) <> 1 THEN
    RAISE EXCEPTION 'four-argument moderation execute boundary was not retired';
  END IF;

  SELECT function_row.prosrc
  INTO STRICT v_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_internal
    AND function_row.prokind = 'f'
    AND function_row.prolang = v_plpgsql_oid
    AND function_row.proowner = v_postgres_oid
    AND function_row.prosecdef
    AND function_row.provolatile = 'v'
    AND function_row.proretset
    AND function_row.proconfig = ARRAY[
      'search_path=pg_catalog, pg_temp',
      'lock_timeout=5s'
    ]::text[];

  IF pg_catalog.md5(v_source) <> '50c413fbae8ce4e83b16e6c1466c5d25'
     OR pg_catalog.obj_description(v_internal::oid, 'pg_proc') IS DISTINCT FROM
       'report-moderation-operation-id:internal-v1:' || pg_catalog.md5(v_source)
     OR pg_catalog.has_function_privilege(
       'service_role', v_internal, 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege('anon', v_internal, 'EXECUTE')
     OR pg_catalog.has_function_privilege(
       'authenticated', v_internal, 'EXECUTE'
     )
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS function_row
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(
           function_row.proacl,
           pg_catalog.acldefault('f', function_row.proowner)
         )
       ) AS acl_entry
       WHERE function_row.oid = v_internal
         AND acl_entry.grantee <> function_row.proowner
     )
  THEN
    RAISE EXCEPTION 'owner-only sealed moderation implementation drifted';
  END IF;

  SELECT function_row.prosrc
  INTO STRICT v_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_new
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
    ]::text[];

  v_auth_lock_position := pg_catalog.strpos(
    v_source,
    'FROM auth.users AS auth_user'
  );
  v_profile_lock_position := pg_catalog.strpos(
    v_source,
    'FROM public.user_profiles AS profile_row'
  );
  v_content_lock_position := pg_catalog.strpos(
    v_source,
    '-- Only after every required profile lock is held may content children be'
  );

  IF pg_catalog.md5(v_source) <> '4796e70c1a1d65b6ce16ff9359f6fcf6'
     OR pg_catalog.obj_description(v_new::oid, 'pg_proc') IS DISTINCT FROM
       'report-moderation-operation-id:v1:' || pg_catalog.md5(v_source)
     OR v_auth_lock_position = 0
     OR v_profile_lock_position <= v_auth_lock_position
     OR v_content_lock_position <= v_profile_lock_position
     OR pg_catalog.strpos(v_source, 'ORDER BY profile_row.id') = 0
     OR pg_catalog.strpos(
       v_source,
       E'ORDER BY profile_row.id\n    FOR UPDATE'
     ) <= v_profile_lock_position
     OR pg_catalog.strpos(v_source, 'report-moderation-operation:') = 0
     OR pg_catalog.strpos(v_source, 'exact atomic moderation audit evidence') = 0
     OR pg_catalog.strpos(v_source, 'legacy destructive evidence conflicts with active content') = 0
     OR NOT pg_catalog.has_function_privilege(
       'service_role', v_new, 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege('anon', v_new, 'EXECUTE')
     OR pg_catalog.has_function_privilege(
       'authenticated', v_new, 'EXECUTE'
     )
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS function_row
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(
           function_row.proacl,
           pg_catalog.acldefault('f', function_row.proowner)
         )
       ) AS acl_entry
       WHERE function_row.oid = v_new
         AND acl_entry.grantee NOT IN (
           function_row.proowner,
           v_service_role_oid
         )
     )
  THEN
    RAISE EXCEPTION 'operation-id moderation wrapper contract drifted';
  END IF;

  IF (
    SELECT NOT relation.relrowsecurity
      OR relation.relforcerowsecurity
      OR relation.relkind <> 'r'
      OR relation.relpersistence <> 'p'
      OR relation.relispartition
      OR relation.relreplident <> 'd'
      OR relation.relowner <> v_postgres_oid
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = v_ledger
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy_row
    WHERE policy_row.polrelid = v_ledger
  ) OR pg_catalog.has_table_privilege(
    'service_role', v_ledger, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
  ) OR pg_catalog.has_table_privilege(
    'anon', v_ledger, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
  ) OR pg_catalog.has_table_privilege(
    'authenticated', v_ledger, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
  ) OR pg_catalog.obj_description(v_ledger::oid, 'pg_class') IS DISTINCT FROM
    'Owner-only permanent idempotency ledger for moderation-queue operation UUIDs; actor IDs intentionally have no deletion-cascading foreign key.'
  OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_inherits AS inheritance
    WHERE inheritance.inhrelid = v_ledger
       OR inheritance.inhparent = v_ledger
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_rewrite AS rewrite_rule
    WHERE rewrite_rule.ev_class = v_ledger
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = v_ledger
  ) OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = v_ledger
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  ) <> 16 OR EXISTS (
    SELECT 1
    FROM (
      VALUES
        (1, 'operation_id', 'uuid', true, false, ''),
        (2, 'actor_id', 'uuid', true, false, ''),
        (3, 'content_type', 'text', true, false, ''),
        (4, 'content_id', 'uuid', true, false, ''),
        (5, 'action', 'text', true, false, ''),
        (6, 'report_ids', 'uuid[]', true, false, ''),
        (7, 'report_status', 'text', true, false, ''),
        (8, 'report_count', 'integer', true, false, ''),
        (9, 'action_taken', 'text', true, false, ''),
        (10, 'author_id', 'uuid', false, false, ''),
        (11, 'content_soft_deleted', 'boolean', false, false, ''),
        (12, 'initial_applied', 'boolean', true, false, ''),
        (13, 'initial_content_affected_count', 'integer', true, false, ''),
        (14, 'initial_strike_id', 'uuid', false, false, ''),
        (15, 'initial_strike_type', 'text', false, false, ''),
        (
          16,
          'created_at',
          'timestamp with time zone',
          true,
          true,
          'clock_timestamp()'
        )
    ) AS expected_column(
      attnum,
      attname,
      type_name,
      is_not_null,
      has_default,
      default_expression
    )
    LEFT JOIN pg_catalog.pg_attribute AS attribute
      ON attribute.attrelid = v_ledger
     AND attribute.attnum = expected_column.attnum
     AND NOT attribute.attisdropped
    LEFT JOIN pg_catalog.pg_attrdef AS default_row
      ON default_row.adrelid = attribute.attrelid
     AND default_row.adnum = attribute.attnum
    WHERE attribute.attname IS NULL
       OR attribute.attname <> expected_column.attname
       OR pg_catalog.format_type(
         attribute.atttypid,
         attribute.atttypmod
       ) <> expected_column.type_name
       OR attribute.attnotnull <> expected_column.is_not_null
       OR attribute.atthasdef <> expected_column.has_default
       OR attribute.attidentity <> ''
       OR attribute.attgenerated <> ''
       OR COALESCE(
         pg_catalog.pg_get_expr(
           default_row.adbin,
           default_row.adrelid,
           true
         ),
         ''
       ) <> expected_column.default_expression
  ) OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = v_ledger
  ) <> 6 OR EXISTS (
    SELECT 1
    FROM (
      VALUES
        (
          'report_moderation_operations_action_check',
          'c'::"char",
          'd55ec29b10fc5aefa18bc6a99c1dfe9d'
        ),
        (
          'report_moderation_operations_content_type_check',
          'c'::"char",
          'f9c35d1b4d6c60522d4384f56dc910a6'
        ),
        (
          'report_moderation_operations_decision_check',
          'c'::"char",
          '98527cba3591c8cec79527eaadfde4b3'
        ),
        (
          'report_moderation_operations_pkey',
          'p'::"char",
          'f59b9d798d6d843ea6ea10575b2ae406'
        ),
        (
          'report_moderation_operations_report_batch_check',
          'c'::"char",
          '472bcb5bca83af97040b4b0df551ca6d'
        ),
        (
          'report_moderation_operations_result_check',
          'c'::"char",
          'a2c739be6df5d2a8416abf333dd5fa8c'
        )
    ) AS expected_constraint(constraint_name, constraint_type, expression_digest)
    LEFT JOIN pg_catalog.pg_constraint AS constraint_row
      ON constraint_row.conrelid = v_ledger
     AND constraint_row.conname = expected_constraint.constraint_name
    WHERE constraint_row.oid IS NULL
       OR constraint_row.contype <> expected_constraint.constraint_type
       OR NOT constraint_row.convalidated
       OR constraint_row.condeferrable
       OR constraint_row.condeferred
       OR constraint_row.conparentid <> 0
       OR (
         expected_constraint.constraint_type = 'c'::"char"
         AND constraint_row.connoinherit
       )
       OR pg_catalog.md5(COALESCE(
         pg_catalog.pg_get_expr(
           constraint_row.conbin,
           constraint_row.conrelid,
           true
         ),
         pg_catalog.pg_get_constraintdef(constraint_row.oid, true)
       )) <> expected_constraint.expression_digest
  ) OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_index AS index_row
    JOIN pg_catalog.pg_class AS index_relation
      ON index_relation.oid = index_row.indexrelid
    JOIN pg_catalog.pg_am AS access_method
      ON access_method.oid = index_relation.relam
    WHERE index_row.indrelid = v_ledger
  ) <> 1 OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index AS index_row
    JOIN pg_catalog.pg_class AS index_relation
      ON index_relation.oid = index_row.indexrelid
    JOIN pg_catalog.pg_am AS access_method
      ON access_method.oid = index_relation.relam
    WHERE index_row.indrelid = v_ledger
      AND index_row.indexrelid = pg_catalog.to_regclass(
        'public.report_moderation_operations_pkey'
      )
      AND index_row.indisunique
      AND index_row.indisprimary
      AND index_row.indisvalid
      AND index_row.indisready
      AND index_row.indimmediate
      AND NOT index_row.indisexclusion
      AND NOT index_row.indisclustered
      AND NOT index_row.indisreplident
      AND index_row.indpred IS NULL
      AND index_row.indexprs IS NULL
      AND index_row.indnkeyatts = 1
      AND index_row.indnatts = 1
      AND index_row.indkey[0] = 1
      AND index_relation.relkind = 'i'
      AND index_relation.relpersistence = 'p'
      AND index_relation.relowner = v_postgres_oid
      AND index_relation.reloptions IS NULL
      AND access_method.amname = 'btree'
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        relation.relacl,
        pg_catalog.acldefault('r', relation.relowner)
      )
    ) AS acl_entry
    WHERE relation.oid = v_ledger
      AND acl_entry.grantee <> relation.relowner
  ) OR (
    SELECT pg_catalog.array_agg(
      acl_entry.privilege_type ORDER BY acl_entry.privilege_type
    )
    FROM pg_catalog.pg_class AS relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        relation.relacl,
        pg_catalog.acldefault('r', relation.relowner)
      )
    ) AS acl_entry
    WHERE relation.oid = v_ledger
      AND acl_entry.grantee = relation.relowner
      AND NOT acl_entry.is_grantable
  ) IS DISTINCT FROM ARRAY[
    'DELETE',
    'INSERT',
    'MAINTAIN',
    'REFERENCES',
    'SELECT',
    'TRIGGER',
    'TRUNCATE',
    'UPDATE'
  ]::text[]
  THEN
    RAISE EXCEPTION 'operation ledger schema or direct-access boundary drifted';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = v_ledger
      AND constraint_row.conname = 'report_moderation_operations_pkey'
      AND constraint_row.contype = 'p'
      AND constraint_row.convalidated
      AND NOT constraint_row.condeferrable
  ) THEN
    RAISE EXCEPTION 'operation ledger primary key drifted';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
