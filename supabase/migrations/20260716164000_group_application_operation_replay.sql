-- Permanently bind group-application submissions and reviews to a caller
-- supplied operation UUID. Successful results are retained without foreign
-- keys so an exact retry can be acknowledged after the application, group, or
-- actor has subsequently changed or been deleted. New operations still check
-- current authority and state. In-app review notifications are inserted in the
-- same transaction as the review; Telegram remains an application-level,
-- best-effort side effect.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('group-application-authority-migrations', 0)
);

DO $preflight$
DECLARE
  v_ledger pg_catalog.regclass := pg_catalog.to_regclass(
    'public.group_application_operation_results'
  );
  v_old_submit pg_catalog.regprocedure := pg_catalog.to_regprocedure(
    'public.submit_group_application_atomic(uuid,text,text,text,text,text,jsonb,jsonb,text,boolean,boolean)'
  );
  v_old_review pg_catalog.regprocedure := pg_catalog.to_regprocedure(
    'public.review_group_application_atomic(uuid,uuid,text,text,boolean)'
  );
  v_new_submit pg_catalog.regprocedure := pg_catalog.to_regprocedure(
    'public.submit_group_application_atomic(uuid,text,text,text,text,text,jsonb,jsonb,text,boolean,boolean,uuid)'
  );
  v_new_review pg_catalog.regprocedure := pg_catalog.to_regprocedure(
    'public.review_group_application_atomic(uuid,uuid,text,text,boolean,uuid)'
  );
  v_relation_name text;
  v_relation pg_catalog.regclass;
  v_invalid_columns text[];
  v_postgres_oid oid := (
    SELECT role_row.oid FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'postgres'
  );
  v_service_role_oid oid := (
    SELECT role_row.oid FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'service_role'
  );
BEGIN
  IF v_postgres_oid IS NULL OR v_service_role_oid IS NULL THEN
    RAISE EXCEPTION 'postgres and service_role must exist';
  END IF;

  FOREACH v_relation_name IN ARRAY ARRAY[
    'user_profiles',
    'subscriptions',
    'groups',
    'group_members',
    'group_applications',
    'group_audit_log',
    'notifications'
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
      SELECT 1 FROM pg_catalog.pg_inherits AS inheritance
      WHERE inheritance.inhrelid = v_relation
         OR inheritance.inhparent = v_relation
    ) THEN
      RAISE EXCEPTION 'public.% must be an ordinary permanent table', v_relation_name;
    END IF;
  END LOOP;

  v_relation := pg_catalog.to_regclass('auth.users');
  IF v_relation IS NULL OR (
    SELECT relation.relkind = 'r'
      AND relation.relpersistence = 'p'
      AND NOT relation.relispartition
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = v_relation
  ) IS NOT TRUE OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = v_relation
      AND attribute.attname = 'id'
      AND attribute.atttypid = 'uuid'::pg_catalog.regtype
      AND attribute.attnotnull
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
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
      ('user_profiles', 1, 'id', 'uuid', true),
      ('user_profiles', 2, 'deleted_at', 'timestamp with time zone', false),
      ('user_profiles', 3, 'banned_at', 'timestamp with time zone', false),
      ('user_profiles', 4, 'is_banned', 'boolean', true),
      ('user_profiles', 5, 'ban_expires_at', 'timestamp with time zone', false),
      ('user_profiles', 6, 'role', 'text', false),
      ('groups', 1, 'id', 'uuid', true),
      ('groups', 2, 'name', 'text', true),
      ('groups', 3, 'slug', 'text', false),
      ('groups', 4, 'created_by', 'uuid', true),
      ('group_members', 1, 'group_id', 'uuid', true),
      ('group_members', 2, 'user_id', 'uuid', true),
      ('group_members', 3, 'role', 'member_role', true),
      ('group_applications', 1, 'id', 'uuid', true),
      ('group_applications', 2, 'applicant_id', 'uuid', true),
      ('group_applications', 3, 'name', 'text', true),
      ('group_applications', 4, 'status', 'text', true),
      ('group_applications', 5, 'reject_reason', 'text', false),
      ('group_applications', 6, 'group_id', 'uuid', false),
      ('group_applications', 7, 'reviewed_at', 'timestamp with time zone', false),
      ('group_applications', 8, 'reviewed_by', 'uuid', false),
      ('group_audit_log', 1, 'group_id', 'uuid', false),
      ('group_audit_log', 2, 'actor_id', 'uuid', false),
      ('group_audit_log', 3, 'action', 'text', true),
      ('group_audit_log', 4, 'target_id', 'uuid', false),
      ('group_audit_log', 5, 'details', 'jsonb', false),
      ('notifications', 1, 'id', 'uuid', true),
      ('notifications', 2, 'user_id', 'uuid', true),
      ('notifications', 3, 'type', 'text', true),
      ('notifications', 4, 'title', 'text', true),
      ('notifications', 5, 'message', 'text', true),
      ('notifications', 6, 'link', 'text', false),
      ('notifications', 7, 'reference_id', 'uuid', false),
      ('notifications', 8, 'read', 'boolean', false)
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
    RAISE EXCEPTION 'group-application operation schema is incompatible: %',
      v_invalid_columns;
  END IF;

  IF pg_catalog.to_regtype('public.member_role') IS NULL OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_enum AS enum_value
    WHERE enum_value.enumtypid = 'public.member_role'::pg_catalog.regtype
      AND enum_value.enumlabel = 'owner'
  ) THEN
    RAISE EXCEPTION 'member_role owner enum value is missing';
  END IF;

  IF v_ledger IS NULL THEN
    IF v_old_submit IS NULL OR v_old_review IS NULL
       OR v_new_submit IS NOT NULL OR v_new_review IS NOT NULL
    THEN
      RAISE EXCEPTION 'canonical legacy group-application RPC baseline is missing';
    END IF;
  ELSE
    IF v_old_submit IS NOT NULL OR v_old_review IS NOT NULL
       OR v_new_submit IS NULL OR v_new_review IS NULL
    THEN
      RAISE EXCEPTION 'partially promoted group-application RPC state detected';
    END IF;

    IF pg_catalog.obj_description(v_new_submit::oid, 'pg_proc') IS DISTINCT FROM
         'group-application-operation-replay:submit:v1:' || (
           SELECT pg_catalog.md5(function_row.prosrc)
           FROM pg_catalog.pg_proc AS function_row
           WHERE function_row.oid = v_new_submit
         )
       OR pg_catalog.obj_description(v_new_review::oid, 'pg_proc') IS DISTINCT FROM
         'group-application-operation-replay:review:v1:' || (
           SELECT pg_catalog.md5(function_row.prosrc)
           FROM pg_catalog.pg_proc AS function_row
           WHERE function_row.oid = v_new_review
         )
    THEN
      RAISE EXCEPTION 'replayed group-application RPC source seal drifted';
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS relation
      WHERE relation.oid = v_ledger
        AND relation.relkind = 'r'
        AND relation.relpersistence = 'p'
        AND NOT relation.relispartition
        AND relation.relowner = v_postgres_oid
        AND relation.relrowsecurity
        AND relation.relforcerowsecurity
    ) OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_constraint AS constraint_row
      WHERE constraint_row.conrelid = v_ledger
        AND constraint_row.contype = 'f'
    ) OR (
      SELECT pg_catalog.count(*)
      FROM pg_catalog.pg_attribute AS attribute
      WHERE attribute.attrelid = v_ledger
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
    ) <> 6 OR EXISTS (
      SELECT 1
      FROM (
        VALUES
          (1, 'operation_id', 'uuid', true, NULL::text),
          (2, 'operation_kind', 'text', true, NULL::text),
          (3, 'actor_id', 'uuid', true, NULL::text),
          (4, 'intent_fingerprint', 'text', true, NULL::text),
          (5, 'result', 'jsonb', true, NULL::text),
          (6, 'created_at', 'timestamp with time zone', true, 'statement_timestamp()')
      ) AS expected_column(
        ordinal_position,
        column_name,
        type_name,
        is_not_null,
        default_expression
      )
      LEFT JOIN pg_catalog.pg_attribute AS attribute
        ON attribute.attrelid = v_ledger
       AND attribute.attnum = expected_column.ordinal_position
       AND NOT attribute.attisdropped
      LEFT JOIN pg_catalog.pg_attrdef AS column_default
        ON column_default.adrelid = attribute.attrelid
       AND column_default.adnum = attribute.attnum
      WHERE attribute.attname IS DISTINCT FROM expected_column.column_name::name
         OR pg_catalog.format_type(attribute.atttypid, attribute.atttypmod)
              IS DISTINCT FROM expected_column.type_name
         OR attribute.attnotnull IS DISTINCT FROM expected_column.is_not_null
         OR attribute.attidentity <> ''
         OR attribute.attgenerated <> ''
         OR pg_catalog.pg_get_expr(
              column_default.adbin,
              column_default.adrelid,
              true
            ) IS DISTINCT FROM expected_column.default_expression
    ) OR (
      SELECT pg_catalog.count(*)
      FROM pg_catalog.pg_constraint AS constraint_row
      WHERE constraint_row.conrelid = v_ledger
    ) <> 4 OR NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_constraint AS constraint_row
      WHERE constraint_row.conrelid = v_ledger
        AND constraint_row.conname = 'group_application_operation_results_pkey'
        AND constraint_row.contype = 'p'
        AND constraint_row.conkey = ARRAY[1]::smallint[]
        AND constraint_row.convalidated
        AND NOT constraint_row.condeferrable
        AND NOT constraint_row.condeferred
    ) OR EXISTS (
      SELECT 1
      FROM (
        VALUES
          (
            'group_application_operation_kind_check',
            'operation_kind = ANY (ARRAY[''submit''::text, ''approve''::text, ''reject''::text])'
          ),
          (
            'group_application_operation_fingerprint_check',
            'intent_fingerprint ~ ''^[0-9a-f]{64}$''::text'
          ),
          (
            'group_application_operation_result_check',
            'jsonb_typeof(result) = ''object''::text'
          )
      ) AS expected_check(constraint_name, expression)
      WHERE NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_constraint AS constraint_row
        WHERE constraint_row.conrelid = v_ledger
          AND constraint_row.conname = expected_check.constraint_name::name
          AND constraint_row.contype = 'c'
          AND constraint_row.convalidated
          AND NOT constraint_row.connoinherit
          AND pg_catalog.pg_get_expr(
            constraint_row.conbin,
            constraint_row.conrelid,
            true
          ) = expected_check.expression
      )
    ) OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS relation
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
      ) AS acl
      WHERE relation.oid = v_ledger
        AND acl.grantee <> relation.relowner
    ) OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_attribute AS attribute
      CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl
      WHERE attribute.attrelid = v_ledger
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
    ) OR EXISTS (
      SELECT 1 FROM pg_catalog.pg_policy AS policy
      WHERE policy.polrelid = v_ledger
    ) OR pg_catalog.obj_description(v_ledger, 'pg_class') IS DISTINCT FROM
      'Permanent no-FK replay ledger for exact group-application operation results.'
    THEN
      RAISE EXCEPTION 'operation result ledger catalog drifted';
    END IF;
  END IF;
END
$preflight$;

-- Do not use CREATE TABLE IF NOT EXISTS here. On replay PostgreSQL would retain
-- a relation lock before the complete dependency lock set is acquired, which
-- defeats the partial-lock rollback guarantee below. A fresh install may create
-- the new ledger outside that set because no installed runtime references it.
DO $create_ledger_only_when_absent$
BEGIN
  IF pg_catalog.to_regclass(
    'public.group_application_operation_results'
  ) IS NULL THEN
    EXECUTE $create_ledger$
      CREATE TABLE public.group_application_operation_results (
        operation_id uuid PRIMARY KEY,
        operation_kind text NOT NULL,
        actor_id uuid NOT NULL,
        intent_fingerprint text NOT NULL,
        result jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT pg_catalog.statement_timestamp(),
        CONSTRAINT group_application_operation_kind_check
          CHECK (operation_kind IN ('submit', 'approve', 'reject')),
        CONSTRAINT group_application_operation_fingerprint_check
          CHECK (intent_fingerprint ~ '^[0-9a-f]{64}$'),
        CONSTRAINT group_application_operation_result_check
          CHECK (pg_catalog.jsonb_typeof(result) = 'object')
      )
    $create_ledger$;
  END IF;
END
$create_ledger_only_when_absent$;

-- Some legacy service writers lock a child before its auth/groups parent.
-- Never wait while holding only a prefix of this DDL lock set: acquire the
-- complete set with NOWAIT inside a subtransaction, so a failed attempt rolls
-- every partial lock back before the bounded retry.
DO $acquire_complete_ddl_lock_set$
DECLARE
  v_attempt integer := 0;
BEGIN
  LOOP
    v_attempt := v_attempt + 1;
    BEGIN
      -- Every promoted runtime locks the ledger first in ROW EXCLUSIVE mode.
      -- Taking its conflicting DDL lock first drains those runtimes before any
      -- dependency lock; a failed later NOWAIT lock releases this whole prefix.
      LOCK TABLE public.group_application_operation_results
        IN ACCESS EXCLUSIVE MODE NOWAIT;
      LOCK TABLE auth.users IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      LOCK TABLE public.user_profiles,
        public.subscriptions,
        public.groups,
        public.group_members,
        public.group_applications,
        public.group_audit_log,
        public.notifications
        IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      EXIT;
    EXCEPTION
      WHEN lock_not_available OR deadlock_detected THEN
        IF v_attempt >= 20 THEN
          RAISE EXCEPTION USING
            ERRCODE = '55P03',
            MESSAGE = 'could not acquire complete group-application DDL lock set';
        END IF;
        PERFORM pg_catalog.pg_sleep(0.025 * v_attempt);
    END;
  END LOOP;
END
$acquire_complete_ddl_lock_set$;

-- Relation mutations happen only after the complete lock set is held. This is
-- essential on replay: none of these statements may leave an early relation
-- lock behind when a later dependency is busy.
ALTER TABLE public.group_application_operation_results OWNER TO postgres;
ALTER TABLE public.group_application_operation_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.group_application_operation_results FORCE ROW LEVEL SECURITY;

DO $revoke_ledger_access$
DECLARE
  v_grantee record;
BEGIN
  FOR v_grantee IN
    SELECT DISTINCT acl.grantee, role_row.rolname
    FROM pg_catalog.pg_class AS relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
    ) AS acl
    LEFT JOIN pg_catalog.pg_roles AS role_row ON role_row.oid = acl.grantee
    WHERE relation.oid = 'public.group_application_operation_results'::pg_catalog.regclass
      AND acl.grantee <> relation.relowner
  LOOP
    IF v_grantee.grantee = 0 THEN
      REVOKE ALL PRIVILEGES ON public.group_application_operation_results FROM PUBLIC;
    ELSIF v_grantee.rolname IS NOT NULL THEN
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON public.group_application_operation_results FROM %I',
        v_grantee.rolname
      );
    END IF;
  END LOOP;
END
$revoke_ledger_access$;

DO $drop_ledger_policies$
DECLARE
  v_policy record;
BEGIN
  FOR v_policy IN
    SELECT policy.polname
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid =
      'public.group_application_operation_results'::pg_catalog.regclass
  LOOP
    EXECUTE pg_catalog.format(
      'DROP POLICY %I ON public.group_application_operation_results',
      v_policy.polname
    );
  END LOOP;
END
$drop_ledger_policies$;

-- Recheck the newly created/replayed ledger only after the complete dependency
-- set is frozen. The earlier preflight is diagnostic; this is the TOCTOU guard.
DO $locked_recheck$
DECLARE
  v_ledger pg_catalog.regclass :=
    'public.group_application_operation_results'::pg_catalog.regclass;
  v_postgres_oid oid := (
    SELECT role_row.oid FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'postgres'
  );
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = v_ledger
      AND relation.relkind = 'r'
      AND relation.relpersistence = 'p'
      AND NOT relation.relispartition
      AND relation.relowner = v_postgres_oid
      AND relation.relrowsecurity
      AND relation.relforcerowsecurity
  ) OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_inherits AS inheritance
    WHERE inheritance.inhrelid = v_ledger
       OR inheritance.inhparent = v_ledger
  ) OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = v_ledger
      AND constraint_row.contype = 'f'
  ) OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = v_ledger
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  ) <> 6 OR EXISTS (
    SELECT 1
    FROM (
      VALUES
        (1, 'operation_id', 'uuid', true, NULL::text),
        (2, 'operation_kind', 'text', true, NULL::text),
        (3, 'actor_id', 'uuid', true, NULL::text),
        (4, 'intent_fingerprint', 'text', true, NULL::text),
        (5, 'result', 'jsonb', true, NULL::text),
        (6, 'created_at', 'timestamp with time zone', true, 'statement_timestamp()')
    ) AS expected_column(
      ordinal_position,
      column_name,
      type_name,
      is_not_null,
      default_expression
    )
    LEFT JOIN pg_catalog.pg_attribute AS attribute
      ON attribute.attrelid = v_ledger
     AND attribute.attnum = expected_column.ordinal_position
     AND NOT attribute.attisdropped
    LEFT JOIN pg_catalog.pg_attrdef AS column_default
      ON column_default.adrelid = attribute.attrelid
     AND column_default.adnum = attribute.attnum
    WHERE attribute.attname IS DISTINCT FROM expected_column.column_name::name
       OR pg_catalog.format_type(attribute.atttypid, attribute.atttypmod)
            IS DISTINCT FROM expected_column.type_name
       OR attribute.attnotnull IS DISTINCT FROM expected_column.is_not_null
       OR attribute.attidentity <> ''
       OR attribute.attgenerated <> ''
       OR pg_catalog.pg_get_expr(
            column_default.adbin,
            column_default.adrelid,
            true
          ) IS DISTINCT FROM expected_column.default_expression
  ) OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = v_ledger
  ) <> 4 OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = v_ledger
      AND constraint_row.conname = 'group_application_operation_results_pkey'
      AND constraint_row.contype = 'p'
      AND constraint_row.conkey = ARRAY[1]::smallint[]
      AND constraint_row.convalidated
      AND NOT constraint_row.condeferrable
      AND NOT constraint_row.condeferred
  ) OR EXISTS (
    SELECT 1
    FROM (
      VALUES
        (
          'group_application_operation_kind_check',
          'operation_kind = ANY (ARRAY[''submit''::text, ''approve''::text, ''reject''::text])'
        ),
        (
          'group_application_operation_fingerprint_check',
          'intent_fingerprint ~ ''^[0-9a-f]{64}$''::text'
        ),
        (
          'group_application_operation_result_check',
          'jsonb_typeof(result) = ''object''::text'
        )
    ) AS expected_check(constraint_name, expression)
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_constraint AS constraint_row
      WHERE constraint_row.conrelid = v_ledger
        AND constraint_row.conname = expected_check.constraint_name::name
        AND constraint_row.contype = 'c'
        AND constraint_row.convalidated
        AND NOT constraint_row.connoinherit
        AND pg_catalog.pg_get_expr(
          constraint_row.conbin,
          constraint_row.conrelid,
          true
        ) = expected_check.expression
    )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
    ) AS acl
    WHERE relation.oid = v_ledger
      AND acl.grantee <> relation.relowner
  ) OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = v_ledger
  ) THEN
    RAISE EXCEPTION 'locked operation result ledger catalog drifted';
  END IF;
END
$locked_recheck$;

DROP FUNCTION IF EXISTS public.submit_group_application_atomic(
  uuid, text, text, text, text, text, jsonb, jsonb, text, boolean, boolean
);
DROP FUNCTION IF EXISTS public.review_group_application_atomic(
  uuid, uuid, text, text, boolean
);

CREATE OR REPLACE FUNCTION public.submit_group_application_atomic(
  p_actor_id uuid,
  p_name text,
  p_name_en text DEFAULT NULL,
  p_description text DEFAULT NULL,
  p_description_en text DEFAULT NULL,
  p_avatar_url text DEFAULT NULL,
  p_role_names jsonb DEFAULT NULL,
  p_rules_json jsonb DEFAULT NULL,
  p_rules text DEFAULT NULL,
  p_is_premium_only boolean DEFAULT false,
  p_promo_unlocked boolean DEFAULT false,
  p_operation_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_application_id uuid;
  v_created_at timestamptz;
  v_effective_operation_id uuid := COALESCE(
    p_operation_id,
    pg_catalog.gen_random_uuid()
  );
  v_existing_actor_id uuid;
  v_existing_fingerprint text;
  v_existing_kind text;
  v_existing_result jsonb;
  v_intent_fingerprint text;
  v_is_legacy boolean := p_operation_id IS NULL;
  v_name text := normalize(pg_catalog.btrim(COALESCE(p_name, '')), NFC);
  v_name_en text := NULLIF(
    normalize(pg_catalog.btrim(COALESCE(p_name_en, '')), NFC),
    ''
  );
  v_description text := NULLIF(
    normalize(pg_catalog.btrim(COALESCE(p_description, '')), NFC),
    ''
  );
  v_description_en text := NULLIF(
    normalize(pg_catalog.btrim(COALESCE(p_description_en, '')), NFC),
    ''
  );
  v_avatar_url text := NULLIF(pg_catalog.btrim(COALESCE(p_avatar_url, '')), '');
  v_rules text := NULLIF(normalize(pg_catalog.btrim(COALESCE(p_rules, '')), NFC), '');
  v_result jsonb;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'service role required';
  END IF;

  -- Deployment barrier: every runtime enters through the ledger before it can
  -- read or lock auth/profile/application/group state. Concurrent runtimes use
  -- compatible locks; a replay migration drains them with SHARE ROW EXCLUSIVE.
  LOCK TABLE public.group_application_operation_results IN ROW EXCLUSIVE MODE;

  IF p_actor_id IS NULL OR v_effective_operation_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;

  v_intent_fingerprint := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_array(
      'submit:v1',
      v_name,
      v_name_en,
      v_description,
      v_description_en,
      v_avatar_url,
      p_role_names,
      p_rules_json,
      v_rules,
      COALESCE(p_is_premium_only, false)
    )::text, 'UTF8')),
    'hex'
  );

  IF NOT v_is_legacy THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'group-application-operation:' || v_effective_operation_id::text,
        0
      )
    );

    SELECT ledger.operation_kind,
      ledger.actor_id,
      ledger.intent_fingerprint,
      ledger.result
    INTO v_existing_kind,
      v_existing_actor_id,
      v_existing_fingerprint,
      v_existing_result
    FROM public.group_application_operation_results AS ledger
    WHERE ledger.operation_id = v_effective_operation_id;

    IF FOUND THEN
      IF v_existing_kind = 'submit'
         AND v_existing_actor_id = p_actor_id
         AND v_existing_fingerprint = v_intent_fingerprint
      THEN
        RETURN v_existing_result ||
          pg_catalog.jsonb_build_object('applied', false);
      END IF;
      RETURN pg_catalog.jsonb_build_object('status', 'operation_conflict');
    END IF;
  END IF;

  IF v_name = ''
    OR pg_catalog.char_length(v_name) > 50
    OR pg_catalog.char_length(COALESCE(v_name_en, '')) > 50
    OR pg_catalog.char_length(COALESCE(v_description, '')) > 500
    OR pg_catalog.char_length(COALESCE(v_description_en, '')) > 500
    OR pg_catalog.char_length(COALESCE(v_avatar_url, '')) > 2048
    OR pg_catalog.char_length(COALESCE(v_rules, '')) > 10000
    OR pg_catalog.pg_column_size(COALESCE(p_role_names, '{}'::jsonb)) > 32768
    OR pg_catalog.pg_column_size(COALESCE(p_rules_json, '[]'::jsonb)) > 65536
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('group-application-actor:' || p_actor_id::text, 0)
  );

  PERFORM 1 FROM auth.users AS auth_user
  WHERE auth_user.id = p_actor_id
  FOR SHARE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'account_inactive');
  END IF;

  PERFORM 1
  FROM public.user_profiles AS profile
  WHERE profile.id = p_actor_id
    AND profile.deleted_at IS NULL
    AND profile.banned_at IS NULL
    AND NOT (
      COALESCE(profile.is_banned, false)
      AND (
        profile.ban_expires_at IS NULL
        OR profile.ban_expires_at > pg_catalog.clock_timestamp()
      )
    )
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'account_inactive');
  END IF;

  IF COALESCE(p_is_premium_only, false)
    AND NOT COALESCE(p_promo_unlocked, false)
    AND NOT public.has_current_global_pro_entitlement(p_actor_id)
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'pro_required');
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.group_applications AS pending_application
    WHERE pending_application.applicant_id = p_actor_id
      AND pending_application.status = 'pending'
  ) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'pending_exists');
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('group-name:' || pg_catalog.lower(v_name), 0)
  );
  IF EXISTS (
    SELECT 1
    FROM public.groups AS existing_group
    WHERE pg_catalog.lower(normalize(existing_group.name, NFC))
      = pg_catalog.lower(v_name)
  ) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'name_taken');
  END IF;

  INSERT INTO public.group_applications (
    applicant_id,
    name,
    name_en,
    description,
    description_en,
    avatar_url,
    role_names,
    rules_json,
    rules,
    is_premium_only,
    status
  ) VALUES (
    p_actor_id,
    v_name,
    v_name_en,
    v_description,
    v_description_en,
    v_avatar_url,
    p_role_names,
    p_rules_json,
    v_rules,
    COALESCE(p_is_premium_only, false),
    'pending'
  )
  RETURNING id, created_at INTO v_application_id, v_created_at;

  v_result := pg_catalog.jsonb_build_object(
    'status', 'submitted',
    'application_id', v_application_id,
    'created_at', v_created_at
  );

  IF NOT v_is_legacy THEN
    v_result := v_result || pg_catalog.jsonb_build_object(
      'operation_id', v_effective_operation_id
    );
    INSERT INTO public.group_application_operation_results (
      operation_id,
      operation_kind,
      actor_id,
      intent_fingerprint,
      result
    ) VALUES (
      v_effective_operation_id,
      'submit',
      p_actor_id,
      v_intent_fingerprint,
      v_result
    );
  END IF;

  IF v_is_legacy THEN
    RETURN v_result;
  END IF;
  RETURN v_result || pg_catalog.jsonb_build_object('applied', true);
END
$function$;

ALTER FUNCTION public.submit_group_application_atomic(
  uuid, text, text, text, text, text, jsonb, jsonb, text, boolean, boolean, uuid
) OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.review_group_application_atomic(
  p_reviewer_id uuid,
  p_application_id uuid,
  p_decision text,
  p_reject_reason text DEFAULT NULL,
  p_promo_unlocked boolean DEFAULT false,
  p_operation_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_application public.group_applications%ROWTYPE;
  v_candidate_applicant_id uuid;
  v_decision text := pg_catalog.lower(pg_catalog.btrim(COALESCE(p_decision, '')));
  v_effective_operation_id uuid := COALESCE(
    p_operation_id,
    pg_catalog.gen_random_uuid()
  );
  v_existing_actor_id uuid;
  v_existing_fingerprint text;
  v_existing_kind text;
  v_existing_result jsonb;
  v_group_id uuid;
  v_intent_fingerprint text;
  v_is_legacy boolean := p_operation_id IS NULL;
  v_locked_auth_ids uuid[] := ARRAY[]::uuid[];
  v_notification_hex text;
  v_notification_id uuid;
  v_notification_message text;
  v_reject_reason text := NULLIF(
    normalize(pg_catalog.btrim(COALESCE(p_reject_reason, '')), NFC),
    ''
  );
  v_required_auth_id uuid;
  v_result jsonb;
  v_safe_group_name text;
  v_slug text;
  v_slug_base text;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'service role required';
  END IF;

  -- Keep the same ledger-first order as submit and the migration DDL barrier.
  LOCK TABLE public.group_application_operation_results IN ROW EXCLUSIVE MODE;

  IF p_reviewer_id IS NULL
    OR p_application_id IS NULL
    OR v_effective_operation_id IS NULL
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;

  v_intent_fingerprint := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_array(
      'review:v1',
      p_application_id,
      v_decision,
      v_reject_reason
    )::text, 'UTF8')),
    'hex'
  );

  IF NOT v_is_legacy THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'group-application-operation:' || v_effective_operation_id::text,
        0
      )
    );

    SELECT ledger.operation_kind,
      ledger.actor_id,
      ledger.intent_fingerprint,
      ledger.result
    INTO v_existing_kind,
      v_existing_actor_id,
      v_existing_fingerprint,
      v_existing_result
    FROM public.group_application_operation_results AS ledger
    WHERE ledger.operation_id = v_effective_operation_id;

    IF FOUND THEN
      IF v_existing_kind = v_decision
         AND v_existing_actor_id = p_reviewer_id
         AND v_existing_fingerprint = v_intent_fingerprint
      THEN
        RETURN v_existing_result ||
          pg_catalog.jsonb_build_object('applied', false);
      END IF;
      RETURN pg_catalog.jsonb_build_object('status', 'operation_conflict');
    END IF;
  END IF;

  IF v_decision NOT IN ('approve', 'reject')
    OR pg_catalog.char_length(COALESCE(v_reject_reason, '')) > 500
    OR (v_decision = 'approve' AND v_reject_reason IS NOT NULL)
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;

  SELECT application.applicant_id
  INTO v_candidate_applicant_id
  FROM public.group_applications AS application
  WHERE application.id = p_application_id;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  FOR v_required_auth_id IN
    SELECT auth_user.id
    FROM auth.users AS auth_user
    WHERE auth_user.id = ANY (
      ARRAY[p_reviewer_id, v_candidate_applicant_id]::uuid[]
    )
    ORDER BY auth_user.id
    FOR SHARE
  LOOP
    v_locked_auth_ids := pg_catalog.array_append(
      v_locked_auth_ids,
      v_required_auth_id
    );
  END LOOP;

  IF NOT p_reviewer_id = ANY (v_locked_auth_ids) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'reviewer_unauthorized');
  END IF;
  IF NOT v_candidate_applicant_id = ANY (v_locked_auth_ids) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'account_inactive');
  END IF;

  PERFORM profile.id
  FROM public.user_profiles AS profile
  WHERE profile.id = ANY (
    ARRAY[p_reviewer_id, v_candidate_applicant_id]::uuid[]
  )
  ORDER BY profile.id
  FOR UPDATE;

  IF NOT EXISTS (
    SELECT 1
    FROM public.user_profiles AS reviewer
    WHERE reviewer.id = p_reviewer_id
      AND reviewer.role = 'admin'
      AND reviewer.deleted_at IS NULL
      AND reviewer.banned_at IS NULL
      AND NOT (
        COALESCE(reviewer.is_banned, false)
        AND (
          reviewer.ban_expires_at IS NULL
          OR reviewer.ban_expires_at > pg_catalog.clock_timestamp()
        )
      )
  ) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'reviewer_unauthorized');
  END IF;

  SELECT application.*
  INTO v_application
  FROM public.group_applications AS application
  WHERE application.id = p_application_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;
  IF v_application.applicant_id IS DISTINCT FROM v_candidate_applicant_id THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;
  IF v_application.status <> 'pending' THEN
    RETURN pg_catalog.jsonb_build_object('status', 'already_processed');
  END IF;

  v_safe_group_name := normalize(
    pg_catalog.btrim(COALESCE(v_application.name, '')),
    NFC
  );
  v_safe_group_name := pg_catalog.btrim(
    pg_catalog.regexp_replace(v_safe_group_name, '[[:cntrl:]]+', ' ', 'g')
  );
  IF v_safe_group_name = '' THEN
    v_safe_group_name := 'Group';
  END IF;
  v_safe_group_name := pg_catalog.left(v_safe_group_name, 50);

  IF v_decision = 'reject' THEN
    UPDATE public.group_applications
    SET status = 'rejected',
        reject_reason = v_reject_reason,
        reviewed_at = pg_catalog.clock_timestamp(),
        reviewed_by = p_reviewer_id
    WHERE id = p_application_id;

    v_result := pg_catalog.jsonb_build_object(
      'status', 'rejected',
      'application_id', v_application.id,
      'applicant_id', v_application.applicant_id,
      'group_name', v_safe_group_name,
      'reject_reason', v_reject_reason
    );
  ELSE
    IF pg_catalog.btrim(COALESCE(v_application.name, '')) = ''
      OR pg_catalog.char_length(
        normalize(pg_catalog.btrim(v_application.name), NFC)
      ) > 50
      OR pg_catalog.char_length(COALESCE(v_application.name_en, '')) > 50
      OR pg_catalog.char_length(COALESCE(v_application.description, '')) > 500
      OR pg_catalog.char_length(COALESCE(v_application.description_en, '')) > 500
      OR pg_catalog.char_length(COALESCE(v_application.avatar_url, '')) > 2048
      OR pg_catalog.char_length(COALESCE(v_application.rules, '')) > 10000
      OR pg_catalog.pg_column_size(
        COALESCE(v_application.role_names, '{}'::jsonb)
      ) > 32768
      OR pg_catalog.pg_column_size(
        COALESCE(v_application.rules_json, '[]'::jsonb)
      ) > 65536
    THEN
      RETURN pg_catalog.jsonb_build_object('status', 'invalid');
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM public.user_profiles AS applicant
      WHERE applicant.id = v_application.applicant_id
        AND applicant.deleted_at IS NULL
        AND applicant.banned_at IS NULL
        AND NOT (
          COALESCE(applicant.is_banned, false)
          AND (
            applicant.ban_expires_at IS NULL
            OR applicant.ban_expires_at > pg_catalog.clock_timestamp()
          )
        )
    ) THEN
      RETURN pg_catalog.jsonb_build_object('status', 'account_inactive');
    END IF;

    IF COALESCE(v_application.is_premium_only, false)
      AND NOT COALESCE(p_promo_unlocked, false)
      AND NOT public.has_current_global_pro_entitlement(v_application.applicant_id)
    THEN
      RETURN pg_catalog.jsonb_build_object('status', 'pro_required');
    END IF;

    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'group-name:' || pg_catalog.lower(
          normalize(v_application.name, NFC)
        ),
        0
      )
    );
    IF EXISTS (
      SELECT 1
      FROM public.groups AS existing_group
      WHERE pg_catalog.lower(normalize(existing_group.name, NFC))
        = pg_catalog.lower(normalize(v_application.name, NFC))
    ) THEN
      RETURN pg_catalog.jsonb_build_object('status', 'name_taken');
    END IF;

    v_group_id := pg_catalog.gen_random_uuid();
    v_slug_base := pg_catalog.btrim(
      pg_catalog.regexp_replace(
        pg_catalog.lower(v_application.name),
        '[^a-z0-9]+',
        '-',
        'g'
      ),
      '-'
    );
    IF v_slug_base = '' THEN
      v_slug_base := 'group';
    END IF;
    v_slug := pg_catalog.left(v_slug_base, 80) || '-' || v_application.id::text;

    INSERT INTO public.groups (
      id,
      name,
      name_en,
      description,
      description_en,
      avatar_url,
      slug,
      created_by,
      role_names,
      rules_json,
      rules,
      is_premium_only
    ) VALUES (
      v_group_id,
      normalize(pg_catalog.btrim(v_application.name), NFC),
      v_application.name_en,
      v_application.description,
      v_application.description_en,
      v_application.avatar_url,
      v_slug,
      v_application.applicant_id,
      v_application.role_names,
      v_application.rules_json,
      v_application.rules,
      COALESCE(v_application.is_premium_only, false)
    );

    INSERT INTO public.group_members (group_id, user_id, role)
    VALUES (
      v_group_id,
      v_application.applicant_id,
      'owner'::public.member_role
    );

    UPDATE public.group_applications
    SET status = 'approved',
        reject_reason = NULL,
        reviewed_at = pg_catalog.clock_timestamp(),
        reviewed_by = p_reviewer_id,
        group_id = v_group_id
    WHERE id = p_application_id;

    INSERT INTO public.group_audit_log (
      group_id,
      actor_id,
      action,
      target_id,
      details
    ) VALUES (
      v_group_id,
      p_reviewer_id,
      'application_approved',
      v_application.applicant_id,
      CASE
        WHEN v_is_legacy THEN
          pg_catalog.jsonb_build_object('application_id', v_application.id)
        ELSE
          pg_catalog.jsonb_build_object(
            'application_id', v_application.id,
            'operation_id', v_effective_operation_id
          )
      END
    );

    v_result := pg_catalog.jsonb_build_object(
      'status', 'approved',
      'application_id', v_application.id,
      'applicant_id', v_application.applicant_id,
      'group_id', v_group_id,
      'group_name', v_safe_group_name
    );
  END IF;

  IF NOT v_is_legacy THEN
    v_result := v_result || pg_catalog.jsonb_build_object(
      'operation_id', v_effective_operation_id
    );

    v_notification_hex := pg_catalog.md5(
      'group-application-notification:' || v_effective_operation_id::text
    );
    v_notification_id := (
      pg_catalog.substr(v_notification_hex, 1, 8) || '-' ||
      pg_catalog.substr(v_notification_hex, 9, 4) || '-' ||
      pg_catalog.substr(v_notification_hex, 13, 4) || '-' ||
      pg_catalog.substr(v_notification_hex, 17, 4) || '-' ||
      pg_catalog.substr(v_notification_hex, 21, 12)
    )::uuid;

    IF v_decision = 'approve' THEN
      v_notification_message := pg_catalog.left(
        'Your group "' || v_safe_group_name || '" has been approved',
        500
      );
      INSERT INTO public.notifications (
        id, user_id, type, title, message, link, reference_id, read
      ) VALUES (
        v_notification_id,
        v_application.applicant_id,
        'system',
        'Group approved',
        v_notification_message,
        '/groups/' || v_group_id::text,
        v_group_id,
        false
      );
    ELSE
      v_notification_message := pg_catalog.left(
        CASE
          WHEN v_reject_reason IS NULL THEN
            'Your group "' || v_safe_group_name || '" was not approved'
          ELSE
            'Your group "' || v_safe_group_name ||
              '" was not approved: ' || v_reject_reason
        END,
        500
      );
      INSERT INTO public.notifications (
        id, user_id, type, title, message, reference_id, read
      ) VALUES (
        v_notification_id,
        v_application.applicant_id,
        'system',
        'Group application rejected',
        v_notification_message,
        v_application.id,
        false
      );
    END IF;

    INSERT INTO public.group_application_operation_results (
      operation_id,
      operation_kind,
      actor_id,
      intent_fingerprint,
      result
    ) VALUES (
      v_effective_operation_id,
      v_decision,
      p_reviewer_id,
      v_intent_fingerprint,
      v_result
    );
  END IF;

  IF v_is_legacy THEN
    RETURN v_result;
  END IF;
  RETURN v_result || pg_catalog.jsonb_build_object('applied', true);
END
$function$;

ALTER FUNCTION public.review_group_application_atomic(
  uuid, uuid, text, text, boolean, uuid
) OWNER TO postgres;

DO $drop_noncanonical_routines$
DECLARE
  v_routine record;
BEGIN
  FOR v_routine IN
    SELECT function_namespace.nspname,
      procedure.proname,
      pg_catalog.pg_get_function_identity_arguments(procedure.oid) AS identity_arguments
    FROM pg_catalog.pg_proc AS procedure
    JOIN pg_catalog.pg_namespace AS function_namespace
      ON function_namespace.oid = procedure.pronamespace
    WHERE function_namespace.nspname = 'public'
      AND procedure.proname IN (
        'submit_group_application_atomic',
        'review_group_application_atomic'
      )
      AND procedure.prokind IN ('f', 'p')
      AND procedure.oid NOT IN (
        'public.submit_group_application_atomic(uuid,text,text,text,text,text,jsonb,jsonb,text,boolean,boolean,uuid)'::pg_catalog.regprocedure,
        'public.review_group_application_atomic(uuid,uuid,text,text,boolean,uuid)'::pg_catalog.regprocedure
      )
  LOOP
    EXECUTE pg_catalog.format(
      'DROP ROUTINE %I.%I(%s) RESTRICT',
      v_routine.nspname,
      v_routine.proname,
      v_routine.identity_arguments
    );
  END LOOP;
END
$drop_noncanonical_routines$;

DO $replace_function_acl$
DECLARE
  v_function pg_catalog.regprocedure;
  v_grantee record;
BEGIN
  FOREACH v_function IN ARRAY ARRAY[
    'public.submit_group_application_atomic(uuid,text,text,text,text,text,jsonb,jsonb,text,boolean,boolean,uuid)'::pg_catalog.regprocedure,
    'public.review_group_application_atomic(uuid,uuid,text,text,boolean,uuid)'::pg_catalog.regprocedure
  ]
  LOOP
    FOR v_grantee IN
      SELECT DISTINCT acl.grantee, role_row.rolname
      FROM pg_catalog.pg_proc AS procedure
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(procedure.proacl, pg_catalog.acldefault('f', procedure.proowner))
      ) AS acl
      LEFT JOIN pg_catalog.pg_roles AS role_row ON role_row.oid = acl.grantee
      WHERE procedure.oid = v_function
        AND acl.grantee <> procedure.proowner
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
  END LOOP;
END
$replace_function_acl$;

GRANT EXECUTE ON FUNCTION public.submit_group_application_atomic(
  uuid, text, text, text, text, text, jsonb, jsonb, text, boolean, boolean, uuid
) TO service_role;
GRANT EXECUTE ON FUNCTION public.review_group_application_atomic(
  uuid, uuid, text, text, boolean, uuid
) TO service_role;

DO $seal_functions$
DECLARE
  v_submit pg_catalog.regprocedure :=
    'public.submit_group_application_atomic(uuid,text,text,text,text,text,jsonb,jsonb,text,boolean,boolean,uuid)'::pg_catalog.regprocedure;
  v_review pg_catalog.regprocedure :=
    'public.review_group_application_atomic(uuid,uuid,text,text,boolean,uuid)'::pg_catalog.regprocedure;
BEGIN
  EXECUTE pg_catalog.format(
    'COMMENT ON FUNCTION %s IS %L',
    v_submit,
    'group-application-operation-replay:submit:v1:' || (
      SELECT pg_catalog.md5(function_row.prosrc)
      FROM pg_catalog.pg_proc AS function_row
      WHERE function_row.oid = v_submit
    )
  );
  EXECUTE pg_catalog.format(
    'COMMENT ON FUNCTION %s IS %L',
    v_review,
    'group-application-operation-replay:review:v1:' || (
      SELECT pg_catalog.md5(function_row.prosrc)
      FROM pg_catalog.pg_proc AS function_row
      WHERE function_row.oid = v_review
    )
  );
END
$seal_functions$;

COMMENT ON TABLE public.group_application_operation_results IS
  'Permanent no-FK replay ledger for exact group-application operation results.';

DO $postflight$
DECLARE
  v_ledger pg_catalog.regclass :=
    'public.group_application_operation_results'::pg_catalog.regclass;
  v_submit pg_catalog.regprocedure :=
    'public.submit_group_application_atomic(uuid,text,text,text,text,text,jsonb,jsonb,text,boolean,boolean,uuid)'::pg_catalog.regprocedure;
  v_review pg_catalog.regprocedure :=
    'public.review_group_application_atomic(uuid,uuid,text,text,boolean,uuid)'::pg_catalog.regprocedure;
  v_postgres_oid oid := (
    SELECT role_row.oid FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'postgres'
  );
  v_service_role_oid oid := (
    SELECT role_row.oid FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'service_role'
  );
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS procedure
    JOIN pg_catalog.pg_namespace AS function_namespace
      ON function_namespace.oid = procedure.pronamespace
    WHERE function_namespace.nspname = 'public'
      AND procedure.proname IN (
        'submit_group_application_atomic',
        'review_group_application_atomic'
      )
      AND procedure.oid NOT IN (v_submit, v_review)
  ) THEN
    RAISE EXCEPTION 'noncanonical group-application overload remains';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS procedure
    WHERE procedure.oid IN (v_submit, v_review)
      AND (
        procedure.proowner <> v_postgres_oid
        OR NOT procedure.prosecdef
        OR procedure.provolatile <> 'v'
        OR procedure.proretset
        OR procedure.prorettype <> 'jsonb'::pg_catalog.regtype
        OR procedure.proconfig <> ARRAY[
          'search_path=pg_catalog, pg_temp',
          'lock_timeout=5s'
        ]::text[]
      )
  ) OR NOT pg_catalog.has_function_privilege('service_role', v_submit, 'EXECUTE')
    OR NOT pg_catalog.has_function_privilege('service_role', v_review, 'EXECUTE')
    OR pg_catalog.has_function_privilege('anon', v_submit, 'EXECUTE')
    OR pg_catalog.has_function_privilege('anon', v_review, 'EXECUTE')
    OR pg_catalog.has_function_privilege('authenticated', v_submit, 'EXECUTE')
    OR pg_catalog.has_function_privilege('authenticated', v_review, 'EXECUTE')
  THEN
    RAISE EXCEPTION 'group-application function contract or ACL is not exact';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS procedure
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(procedure.proacl, pg_catalog.acldefault('f', procedure.proowner))
    ) AS acl
    WHERE procedure.oid IN (v_submit, v_review)
      AND acl.grantee NOT IN (procedure.proowner, v_service_role_oid)
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS procedure
    CROSS JOIN LATERAL pg_catalog.aclexplode(procedure.proacl) AS acl
    WHERE procedure.oid IN (v_submit, v_review)
      AND acl.grantee = v_service_role_oid
      AND (acl.privilege_type <> 'EXECUTE' OR acl.is_grantable)
  ) THEN
    RAISE EXCEPTION 'unexpected group-application function grant remains';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = v_ledger
      AND relation.relowner = v_postgres_oid
      AND relation.relrowsecurity
      AND relation.relforcerowsecurity
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
    ) AS acl
    WHERE relation.oid = v_ledger
      AND acl.grantee <> relation.relowner
  ) OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = v_ledger
  ) OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = v_ledger
      AND constraint_row.contype = 'f'
  ) OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = v_ledger
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  ) <> 6 OR EXISTS (
    SELECT 1
    FROM (
      VALUES
        (1, 'operation_id', 'uuid', true, NULL::text),
        (2, 'operation_kind', 'text', true, NULL::text),
        (3, 'actor_id', 'uuid', true, NULL::text),
        (4, 'intent_fingerprint', 'text', true, NULL::text),
        (5, 'result', 'jsonb', true, NULL::text),
        (6, 'created_at', 'timestamp with time zone', true, 'statement_timestamp()')
    ) AS expected_column(
      ordinal_position,
      column_name,
      type_name,
      is_not_null,
      default_expression
    )
    LEFT JOIN pg_catalog.pg_attribute AS attribute
      ON attribute.attrelid = v_ledger
     AND attribute.attnum = expected_column.ordinal_position
     AND NOT attribute.attisdropped
    LEFT JOIN pg_catalog.pg_attrdef AS column_default
      ON column_default.adrelid = attribute.attrelid
     AND column_default.adnum = attribute.attnum
    WHERE attribute.attname IS DISTINCT FROM expected_column.column_name::name
       OR pg_catalog.format_type(attribute.atttypid, attribute.atttypmod)
            IS DISTINCT FROM expected_column.type_name
       OR attribute.attnotnull IS DISTINCT FROM expected_column.is_not_null
       OR attribute.attidentity <> ''
       OR attribute.attgenerated <> ''
       OR pg_catalog.pg_get_expr(
            column_default.adbin,
            column_default.adrelid,
            true
          ) IS DISTINCT FROM expected_column.default_expression
  ) OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = v_ledger
  ) <> 4 OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = v_ledger
      AND constraint_row.conname = 'group_application_operation_results_pkey'
      AND constraint_row.contype = 'p'
      AND constraint_row.conkey = ARRAY[1]::smallint[]
      AND constraint_row.convalidated
      AND NOT constraint_row.condeferrable
      AND NOT constraint_row.condeferred
  ) OR EXISTS (
    SELECT 1
    FROM (
      VALUES
        (
          'group_application_operation_kind_check',
          'operation_kind = ANY (ARRAY[''submit''::text, ''approve''::text, ''reject''::text])'
        ),
        (
          'group_application_operation_fingerprint_check',
          'intent_fingerprint ~ ''^[0-9a-f]{64}$''::text'
        ),
        (
          'group_application_operation_result_check',
          'jsonb_typeof(result) = ''object''::text'
        )
    ) AS expected_check(constraint_name, expression)
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_constraint AS constraint_row
      WHERE constraint_row.conrelid = v_ledger
        AND constraint_row.conname = expected_check.constraint_name::name
        AND constraint_row.contype = 'c'
        AND constraint_row.convalidated
        AND NOT constraint_row.connoinherit
        AND pg_catalog.pg_get_expr(
          constraint_row.conbin,
          constraint_row.conrelid,
          true
        ) = expected_check.expression
    )
  ) THEN
    RAISE EXCEPTION 'operation result ledger authority is not exact';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
