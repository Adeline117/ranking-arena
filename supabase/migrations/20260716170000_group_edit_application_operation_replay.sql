-- Make group-profile edit submission and review one atomic, permanently
-- replayable authority boundary.  Successful operation results deliberately
-- have no foreign keys: an exact retry remains answerable after account/group
-- hard deletion.  Fresh operations always re-check current authority/state.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('group-application-authority-migrations', 0)
);

DO $preflight$
DECLARE
  v_relation_name text;
  v_relation pg_catalog.regclass;
  v_edit pg_catalog.regclass :=
    pg_catalog.to_regclass('public.group_edit_applications');
  v_ledger pg_catalog.regclass :=
    pg_catalog.to_regclass('public.group_edit_application_operation_results');
  v_submit pg_catalog.regprocedure := pg_catalog.to_regprocedure(
    'public.submit_group_edit_application_atomic(uuid,uuid,text,text,text,text,text,jsonb,jsonb,text,boolean,uuid)'
  );
  v_review pg_catalog.regprocedure := pg_catalog.to_regprocedure(
    'public.review_group_edit_application_atomic(uuid,uuid,text,text,uuid)'
  );
  v_guard pg_catalog.regprocedure := pg_catalog.to_regprocedure(
    'public.enforce_group_profile_edit_write()'
  );
  v_postgres_oid oid := (
    SELECT role_row.oid FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'postgres'
  );
  v_service_oid oid := (
    SELECT role_row.oid FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'service_role'
  );
BEGIN
  IF v_postgres_oid IS NULL OR v_service_oid IS NULL OR EXISTS (
    SELECT 1
    FROM pg_catalog.unnest(ARRAY['anon', 'authenticated']::name[]) AS required(role_name)
    LEFT JOIN pg_catalog.pg_roles AS role_row
      ON role_row.rolname = required.role_name
    WHERE role_row.oid IS NULL
  ) THEN
    RAISE EXCEPTION 'required application database role is missing';
  END IF;

  IF pg_catalog.to_regprocedure('auth.uid()') IS NULL
    OR pg_catalog.to_regprocedure('auth.role()') IS NULL OR (
    SELECT function_row.prorettype
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = 'auth.role()'::pg_catalog.regprocedure
  ) <> 'text'::pg_catalog.regtype THEN
    RAISE EXCEPTION 'auth.role() returning text must exist';
  END IF;

  FOREACH v_relation_name IN ARRAY ARRAY[
    'auth.users',
    'public.user_profiles',
    'public.groups',
    'public.group_members',
    'public.group_audit_log',
    'public.notifications'
  ]::text[]
  LOOP
    v_relation := pg_catalog.to_regclass(v_relation_name);
    IF v_relation IS NULL OR NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS relation
      WHERE relation.oid = v_relation
        AND relation.relkind = 'r'
        AND relation.relpersistence = 'p'
        AND NOT relation.relispartition
    ) OR EXISTS (
      SELECT 1 FROM pg_catalog.pg_inherits AS inheritance
      WHERE inheritance.inhrelid = v_relation
         OR inheritance.inhparent = v_relation
    ) THEN
      RAISE EXCEPTION 'group-edit dependency must be an ordinary permanent table: %',
        v_relation_name;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid IN (
      'public.user_profiles'::pg_catalog.regclass,
      'public.groups'::pg_catalog.regclass,
      'public.group_members'::pg_catalog.regclass,
      'public.group_audit_log'::pg_catalog.regclass,
      'public.notifications'::pg_catalog.regclass
    )
      AND relation.relowner <> v_postgres_oid
  ) THEN
    RAISE EXCEPTION 'group-edit public dependencies must be postgres-owned';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('auth', 'users', 'id', 'uuid'::pg_catalog.regtype, true),
        ('public', 'user_profiles', 'id', 'uuid'::pg_catalog.regtype, true),
        ('public', 'user_profiles', 'deleted_at', 'timestamptz'::pg_catalog.regtype, false),
        ('public', 'user_profiles', 'banned_at', 'timestamptz'::pg_catalog.regtype, false),
        ('public', 'user_profiles', 'is_banned', 'boolean'::pg_catalog.regtype, false),
        ('public', 'user_profiles', 'ban_expires_at', 'timestamptz'::pg_catalog.regtype, false),
        ('public', 'user_profiles', 'role', 'text'::pg_catalog.regtype, false),
        ('public', 'groups', 'id', 'uuid'::pg_catalog.regtype, true),
        ('public', 'groups', 'name', 'text'::pg_catalog.regtype, true),
        ('public', 'groups', 'name_en', 'text'::pg_catalog.regtype, false),
        ('public', 'groups', 'description', 'text'::pg_catalog.regtype, false),
        ('public', 'groups', 'description_en', 'text'::pg_catalog.regtype, false),
        ('public', 'groups', 'avatar_url', 'text'::pg_catalog.regtype, false),
        ('public', 'groups', 'created_by', 'uuid'::pg_catalog.regtype, true),
        ('public', 'groups', 'role_names', 'jsonb'::pg_catalog.regtype, false),
        ('public', 'groups', 'rules_json', 'jsonb'::pg_catalog.regtype, false),
        ('public', 'groups', 'rules', 'text'::pg_catalog.regtype, false),
        ('public', 'groups', 'is_premium_only', 'boolean'::pg_catalog.regtype, false),
        ('public', 'groups', 'member_count', 'integer'::pg_catalog.regtype, false),
        ('public', 'groups', 'dissolved_at', 'timestamptz'::pg_catalog.regtype, false),
        ('public', 'groups', 'updated_at', 'timestamptz'::pg_catalog.regtype, false),
        ('public', 'group_members', 'group_id', 'uuid'::pg_catalog.regtype, true),
        ('public', 'group_members', 'user_id', 'uuid'::pg_catalog.regtype, true),
        ('public', 'group_members', 'role', 'public.member_role'::pg_catalog.regtype, true),
        ('public', 'group_audit_log', 'group_id', 'uuid'::pg_catalog.regtype, false),
        ('public', 'group_audit_log', 'actor_id', 'uuid'::pg_catalog.regtype, false),
        ('public', 'group_audit_log', 'action', 'text'::pg_catalog.regtype, true),
        ('public', 'group_audit_log', 'target_id', 'uuid'::pg_catalog.regtype, false),
        ('public', 'group_audit_log', 'details', 'jsonb'::pg_catalog.regtype, false),
        ('public', 'notifications', 'id', 'uuid'::pg_catalog.regtype, true),
        ('public', 'notifications', 'user_id', 'uuid'::pg_catalog.regtype, true),
        ('public', 'notifications', 'type', 'text'::pg_catalog.regtype, true),
        ('public', 'notifications', 'title', 'text'::pg_catalog.regtype, true),
        ('public', 'notifications', 'message', 'text'::pg_catalog.regtype, true),
        ('public', 'notifications', 'link', 'text'::pg_catalog.regtype, false),
        ('public', 'notifications', 'actor_id', 'uuid'::pg_catalog.regtype, false),
        ('public', 'notifications', 'reference_id', 'uuid'::pg_catalog.regtype, false),
        ('public', 'notifications', 'read', 'boolean'::pg_catalog.regtype, false)
    ) AS required_column(
      schema_name, relation_name, column_name, type_oid, required_not_null
    )
    LEFT JOIN pg_catalog.pg_attribute AS attribute
      ON attribute.attrelid = pg_catalog.to_regclass(
        pg_catalog.format('%I.%I', required_column.schema_name, required_column.relation_name)
      )
     AND attribute.attname = required_column.column_name
     AND attribute.attnum > 0
     AND NOT attribute.attisdropped
    WHERE attribute.attnum IS NULL
       OR attribute.atttypid <> required_column.type_oid
       OR attribute.attgenerated <> ''
       OR (required_column.required_not_null AND NOT attribute.attnotnull)
  ) THEN
    RAISE EXCEPTION 'group-edit dependency columns are incompatible';
  END IF;

  IF pg_catalog.to_regtype('public.member_role') IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_enum AS enum_row
    WHERE enum_row.enumtypid = 'public.member_role'::pg_catalog.regtype
      AND enum_row.enumlabel = 'owner'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_enum AS enum_row
    WHERE enum_row.enumtypid = 'public.member_role'::pg_catalog.regtype
      AND enum_row.enumlabel = 'admin'
  ) THEN
    RAISE EXCEPTION 'required group owner/admin role labels are missing';
  END IF;

  -- PostgreSQL 17 models inheritance per membership edge.  SET-only grants
  -- (the normal authenticator -> service_role edge) are safe; inherited ones
  -- would expose every service-only RPC/table privilege.
  IF EXISTS (
    WITH RECURSIVE service_inheritors(member_oid) AS (
      SELECT membership.member
      FROM pg_catalog.pg_auth_members AS membership
      WHERE membership.roleid = v_service_oid
        AND membership.inherit_option
      UNION
      SELECT membership.member
      FROM pg_catalog.pg_auth_members AS membership
      JOIN service_inheritors AS inherited
        ON membership.roleid = inherited.member_oid
      WHERE membership.inherit_option
    )
    SELECT 1 FROM service_inheritors AS inherited
    WHERE inherited.member_oid <> v_postgres_oid
  ) OR EXISTS (
    WITH RECURSIVE service_inherits(role_oid) AS (
      SELECT membership.roleid
      FROM pg_catalog.pg_auth_members AS membership
      WHERE membership.member = v_service_oid
        AND membership.inherit_option
      UNION
      SELECT membership.roleid
      FROM pg_catalog.pg_auth_members AS membership
      JOIN service_inherits AS inherited
        ON membership.member = inherited.role_oid
      WHERE membership.inherit_option
    )
    SELECT 1 FROM service_inherits
  ) THEN
    RAISE EXCEPTION 'service_role has an unsafe effective inheritance edge';
  END IF;

  IF v_edit IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_class AS relation
      WHERE relation.oid = v_edit
        AND relation.relkind = 'r'
        AND relation.relpersistence = 'p'
        AND NOT relation.relispartition
        AND relation.relowner = v_postgres_oid
    ) OR EXISTS (
      SELECT 1 FROM pg_catalog.pg_inherits AS inheritance
      WHERE inheritance.inhrelid = v_edit OR inheritance.inhparent = v_edit
    ) THEN
      RAISE EXCEPTION 'public.group_edit_applications is incompatible';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM (
        VALUES
          ('id', 'uuid'::pg_catalog.regtype, true),
          ('group_id', 'uuid'::pg_catalog.regtype, true),
          ('applicant_id', 'uuid'::pg_catalog.regtype, true),
          ('name', 'text'::pg_catalog.regtype, false),
          ('name_en', 'text'::pg_catalog.regtype, false),
          ('description', 'text'::pg_catalog.regtype, false),
          ('description_en', 'text'::pg_catalog.regtype, false),
          ('avatar_url', 'text'::pg_catalog.regtype, false),
          ('role_names', 'jsonb'::pg_catalog.regtype, false),
          ('rules_json', 'jsonb'::pg_catalog.regtype, false),
          ('rules', 'text'::pg_catalog.regtype, false),
          ('is_premium_only', 'boolean'::pg_catalog.regtype, false),
          ('status', 'text'::pg_catalog.regtype, false),
          ('reject_reason', 'text'::pg_catalog.regtype, false),
          ('created_at', 'timestamptz'::pg_catalog.regtype, false),
          ('reviewed_at', 'timestamptz'::pg_catalog.regtype, false),
          ('reviewed_by', 'uuid'::pg_catalog.regtype, false)
      ) AS required_column(column_name, type_oid, required_not_null)
      LEFT JOIN pg_catalog.pg_attribute AS attribute
        ON attribute.attrelid = v_edit
       AND attribute.attname = required_column.column_name
       AND attribute.attnum > 0
       AND NOT attribute.attisdropped
      WHERE attribute.attnum IS NULL
         OR attribute.atttypid <> required_column.type_oid
         OR attribute.attgenerated <> ''
         OR (required_column.required_not_null AND NOT attribute.attnotnull)
    ) THEN
      RAISE EXCEPTION 'group-edit application columns are incompatible';
    END IF;

    IF (
      SELECT pg_catalog.count(*)
      FROM pg_catalog.pg_constraint AS constraint_row
      WHERE constraint_row.conrelid = v_edit
        AND constraint_row.contype = 'p'
        AND constraint_row.conkey = ARRAY[(
          SELECT attribute.attnum
          FROM pg_catalog.pg_attribute AS attribute
          WHERE attribute.attrelid = v_edit AND attribute.attname = 'id'
        )]::smallint[]
        AND constraint_row.convalidated
        AND NOT constraint_row.condeferrable
    ) <> 1 THEN
      RAISE EXCEPTION 'group-edit application primary key is incompatible';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM pg_catalog.pg_trigger AS trigger_row
      WHERE trigger_row.tgrelid = v_edit
        AND NOT trigger_row.tgisinternal
        AND (
          trigger_row.tgname NOT IN ('on_group_edit_approved', 'on_group_edit_rejected')
          OR trigger_row.tgenabled <> 'O'
          OR trigger_row.tgtype <> 17
          OR trigger_row.tgqual IS NOT NULL
          OR trigger_row.tgnargs <> 0
          OR trigger_row.tgattr::text <> ''
          OR (
            trigger_row.tgname = 'on_group_edit_approved'
            AND trigger_row.tgfoid IS DISTINCT FROM
              pg_catalog.to_regprocedure('public.handle_group_edit_approved()')::oid
          )
          OR (
            trigger_row.tgname = 'on_group_edit_rejected'
            AND trigger_row.tgfoid IS DISTINCT FROM
              pg_catalog.to_regprocedure('public.handle_group_edit_rejected()')::oid
          )
        )
    ) THEN
      RAISE EXCEPTION 'unknown group-edit application trigger detected';
    END IF;
  END IF;

  IF (v_ledger IS NULL) <> (v_submit IS NULL) OR
     (v_ledger IS NULL) <> (v_review IS NULL) OR
     (v_ledger IS NOT NULL AND v_edit IS NULL)
  THEN
    RAISE EXCEPTION 'partially promoted group-edit operation boundary detected';
  END IF;

  IF v_ledger IS NULL THEN
    IF pg_catalog.to_regprocedure('public.enforce_group_profile_edit_write()') IS NOT NULL OR EXISTS (
      SELECT 1 FROM pg_catalog.pg_trigger AS trigger_row
      WHERE trigger_row.tgrelid = 'public.groups'::pg_catalog.regclass
        AND trigger_row.tgname = 'trg_groups_06_guard_profile_edit'
        AND NOT trigger_row.tgisinternal
    ) THEN
      RAISE EXCEPTION 'partial legacy group-profile edit guard detected';
    END IF;
  ELSE
    IF v_guard IS NULL OR pg_catalog.obj_description(v_submit::oid, 'pg_proc') IS DISTINCT FROM
      'group-edit-application-operation-replay:submit:v1:' || (
        SELECT pg_catalog.md5(function_row.prosrc)
        FROM pg_catalog.pg_proc AS function_row WHERE function_row.oid = v_submit
      ) OR pg_catalog.obj_description(v_review::oid, 'pg_proc') IS DISTINCT FROM
      'group-edit-application-operation-replay:review:v1:' || (
        SELECT pg_catalog.md5(function_row.prosrc)
        FROM pg_catalog.pg_proc AS function_row WHERE function_row.oid = v_review
      )
      OR pg_catalog.obj_description(v_guard::oid, 'pg_proc') IS DISTINCT FROM
      'group-edit-application-operation-replay:profile-guard:v1:' || (
        SELECT pg_catalog.md5(function_row.prosrc)
        FROM pg_catalog.pg_proc AS function_row WHERE function_row.oid = v_guard
      )
      OR NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_trigger AS trigger_row
        WHERE trigger_row.tgrelid = 'public.groups'::pg_catalog.regclass
          AND trigger_row.tgname = 'trg_groups_06_guard_profile_edit'
          AND trigger_row.tgfoid = v_guard
          AND trigger_row.tgenabled = 'O'
          AND trigger_row.tgtype = 19
          AND trigger_row.tgqual IS NULL
          AND trigger_row.tgnargs = 0
          AND NOT trigger_row.tgisinternal
      )
      OR EXISTS (
        SELECT 1
        FROM pg_catalog.pg_trigger AS trigger_row
        WHERE trigger_row.tgrelid = v_ledger
          AND NOT trigger_row.tgisinternal
      )
    THEN
      RAISE EXCEPTION 'replayed group-edit RPC/guard source seal drifted';
    END IF;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.pronamespace = 'public'::pg_catalog.regnamespace
      AND function_row.proname IN (
        'submit_group_edit_application_atomic',
        'review_group_edit_application_atomic'
      )
      AND function_row.oid NOT IN (
        COALESCE(v_submit::oid, 0),
        COALESCE(v_review::oid, 0),
        COALESCE(pg_catalog.to_regprocedure(
          'public.submit_group_edit_application_atomic(uuid,uuid,text,text,text,text,text,jsonb,jsonb,text,boolean)'
        )::oid, 0),
        COALESCE(pg_catalog.to_regprocedure(
          'public.review_group_edit_application_atomic(uuid,uuid,text,text)'
        )::oid, 0)
      )
  ) THEN
    RAISE EXCEPTION 'incompatible group-edit RPC overload exists';
  END IF;
END
$preflight$;

-- Guarded CREATE branches execute only for a genuinely fresh object.  Unlike
-- CREATE TABLE IF NOT EXISTS on replay, they cannot retain a relation lock
-- before the complete all-or-nothing dependency lock protocol.  The fresh
-- application table intentionally receives its FKs only after that protocol.
DO $create_application_only_when_absent$
BEGIN
  IF pg_catalog.to_regclass('public.group_edit_applications') IS NULL THEN
    CREATE TABLE public.group_edit_applications (
      id uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
      group_id uuid NOT NULL,
      applicant_id uuid NOT NULL,
      name text,
      name_en text,
      description text,
      description_en text,
      avatar_url text,
      role_names jsonb,
      rules_json jsonb,
      rules text,
      is_premium_only boolean,
      status text NOT NULL DEFAULT 'pending',
      reject_reason text,
      created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
      reviewed_at timestamptz,
      reviewed_by uuid,
      CONSTRAINT group_edit_applications_pkey PRIMARY KEY (id)
    );
  END IF;
END
$create_application_only_when_absent$;

DO $create_ledger_only_when_absent$
BEGIN
  IF pg_catalog.to_regclass(
    'public.group_edit_application_operation_results'
  ) IS NULL THEN
    CREATE TABLE public.group_edit_application_operation_results (
      operation_id uuid NOT NULL,
      operation_kind text NOT NULL,
      actor_id uuid NOT NULL,
      intent_fingerprint text NOT NULL,
      result jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT pg_catalog.statement_timestamp(),
      CONSTRAINT group_edit_application_operation_results_pkey
        PRIMARY KEY (operation_id),
      CONSTRAINT group_edit_application_operation_kind_check
        CHECK (operation_kind IN ('submit', 'approve', 'reject')),
      CONSTRAINT group_edit_application_operation_fingerprint_check
        CHECK (intent_fingerprint ~ '^[0-9a-f]{64}$'),
      CONSTRAINT group_edit_application_operation_result_check
        CHECK (
          pg_catalog.jsonb_typeof(result) = 'object'
          AND NOT result ? 'applied'
          AND result ->> 'operation_id' = operation_id::text
          AND (
            (operation_kind = 'submit' AND result ->> 'status' = 'submitted')
            OR (operation_kind = 'approve' AND result ->> 'status' = 'approved')
            OR (operation_kind = 'reject' AND result ->> 'status' = 'rejected')
          )
        )
    );
  END IF;
END
$create_ledger_only_when_absent$;

-- Each failed NOWAIT attempt is an exception subtransaction, so every partial
-- lock acquired by that attempt is released before retry.  Ledger first is the
-- deployment barrier shared by both promoted runtimes.
DO $acquire_complete_ddl_lock_set$
DECLARE
  v_deadline timestamptz := pg_catalog.clock_timestamp() + interval '30 seconds';
  v_complete boolean;
BEGIN
  LOOP
    v_complete := false;
    BEGIN
      LOCK TABLE public.group_edit_application_operation_results
        IN ACCESS EXCLUSIVE MODE NOWAIT;
      LOCK TABLE auth.users, public.user_profiles
        IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      LOCK TABLE public.groups, public.group_members,
        public.group_edit_applications
        IN ACCESS EXCLUSIVE MODE NOWAIT;
      LOCK TABLE public.group_audit_log, public.notifications
        IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      v_complete := true;
    EXCEPTION
      WHEN lock_not_available THEN
        NULL;
    END;

    EXIT WHEN v_complete;
    IF pg_catalog.clock_timestamp() >= v_deadline THEN
      RAISE EXCEPTION USING
        ERRCODE = '55P03',
        MESSAGE = 'timed out acquiring the atomic group-edit migration lock set';
    END IF;
    PERFORM pg_catalog.pg_sleep(0.05);
  END LOOP;
END
$acquire_complete_ddl_lock_set$;

ALTER TABLE public.group_edit_applications OWNER TO postgres;
ALTER TABLE public.group_edit_application_operation_results OWNER TO postgres;

DO $locked_recheck$
DECLARE
  v_edit pg_catalog.regclass :=
    'public.group_edit_applications'::pg_catalog.regclass;
  v_ledger pg_catalog.regclass :=
    'public.group_edit_application_operation_results'::pg_catalog.regclass;
  v_postgres_oid oid := (
    SELECT role_row.oid FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'postgres'
  );
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid IN (v_edit, v_ledger)
      AND (
        relation.relkind <> 'r'
        OR relation.relpersistence <> 'p'
        OR relation.relispartition
        OR relation.relowner <> v_postgres_oid
      )
  ) OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_inherits AS inheritance
    WHERE inheritance.inhrelid IN (v_edit, v_ledger)
       OR inheritance.inhparent IN (v_edit, v_ledger)
  ) OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = v_ledger
      AND constraint_row.contype = 'f'
  ) OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = v_ledger
      AND NOT trigger_row.tgisinternal
  ) THEN
    RAISE EXCEPTION 'locked group-edit application/ledger catalog drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = v_edit
      AND NOT trigger_row.tgisinternal
      AND (
        trigger_row.tgname NOT IN ('on_group_edit_approved', 'on_group_edit_rejected')
        OR trigger_row.tgenabled <> 'O'
        OR trigger_row.tgtype <> 17
        OR trigger_row.tgqual IS NOT NULL
        OR trigger_row.tgnargs <> 0
        OR trigger_row.tgattr::text <> ''
        OR (
          trigger_row.tgname = 'on_group_edit_approved'
          AND trigger_row.tgfoid IS DISTINCT FROM
            pg_catalog.to_regprocedure('public.handle_group_edit_approved()')::oid
        )
        OR (
          trigger_row.tgname = 'on_group_edit_rejected'
          AND trigger_row.tgfoid IS DISTINCT FROM
            pg_catalog.to_regprocedure('public.handle_group_edit_rejected()')::oid
        )
      )
  ) THEN
    RAISE EXCEPTION 'unknown locked group-edit application trigger detected';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.groups'::pg_catalog.regclass
      AND trigger_row.tgname = 'trg_groups_06_guard_profile_edit'
      AND NOT trigger_row.tgisinternal
      AND (
        trigger_row.tgenabled <> 'O'
        OR trigger_row.tgfoid IS DISTINCT FROM
          pg_catalog.to_regprocedure('public.enforce_group_profile_edit_write()')::oid
      )
  ) THEN
    RAISE EXCEPTION 'locked group-profile edit guard drifted';
  END IF;
END
$locked_recheck$;

-- Retire only the two historical out-of-band side-effect triggers.  Any other
-- non-internal trigger failed the checks above, and RESTRICT catches hidden
-- dependencies on their functions instead of silently deleting behavior.
DROP TRIGGER IF EXISTS on_group_edit_approved
  ON public.group_edit_applications;
DROP TRIGGER IF EXISTS on_group_edit_rejected
  ON public.group_edit_applications;
DROP FUNCTION IF EXISTS public.handle_group_edit_approved() RESTRICT;
DROP FUNCTION IF EXISTS public.handle_group_edit_rejected() RESTRICT;

ALTER TABLE public.group_edit_applications OWNER TO postgres;
ALTER TABLE public.group_edit_application_operation_results OWNER TO postgres;

UPDATE public.group_edit_applications
SET status = 'rejected',
    reject_reason = COALESCE(
      reject_reason,
      'Invalid legacy status reconciled by the atomic edit boundary'
    ),
    reviewed_at = COALESCE(reviewed_at, pg_catalog.statement_timestamp()),
    reviewed_by = NULL
WHERE status IS NULL OR status NOT IN ('pending', 'approved', 'rejected');

UPDATE public.group_edit_applications
SET created_at = pg_catalog.statement_timestamp()
WHERE created_at IS NULL;

-- Keep the oldest pending row per group.  Reconciliation is deterministic and
-- remains visible as both application state and an audit fact.
WITH ranked_pending AS (
  SELECT application.id,
    pg_catalog.row_number() OVER (
      PARTITION BY application.group_id
      ORDER BY application.created_at, application.id
    ) AS pending_rank
  FROM public.group_edit_applications AS application
  WHERE application.status = 'pending'
), reconciled AS (
  UPDATE public.group_edit_applications AS application
  SET status = 'rejected',
      reject_reason = 'Superseded during duplicate-pending reconciliation',
      reviewed_at = pg_catalog.statement_timestamp(),
      reviewed_by = NULL
  FROM ranked_pending
  WHERE ranked_pending.id = application.id
    AND ranked_pending.pending_rank > 1
  RETURNING application.id, application.group_id, application.applicant_id
)
INSERT INTO public.group_audit_log (
  group_id, actor_id, action, target_id, details
)
SELECT reconciled.group_id,
  reconciled.applicant_id,
  'edit_application_reconciled',
  reconciled.id,
  pg_catalog.jsonb_build_object('reason', 'duplicate_pending')
FROM reconciled;

ALTER TABLE public.group_edit_applications
  ALTER COLUMN id SET DEFAULT pg_catalog.gen_random_uuid(),
  ALTER COLUMN status SET DEFAULT 'pending',
  ALTER COLUMN status SET NOT NULL,
  ALTER COLUMN created_at SET DEFAULT pg_catalog.clock_timestamp(),
  ALTER COLUMN created_at SET NOT NULL;

DO $replace_application_foreign_keys_and_status_check$
DECLARE
  v_constraint record;
  v_status_attnum smallint := (
    SELECT attribute.attnum
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = 'public.group_edit_applications'::pg_catalog.regclass
      AND attribute.attname = 'status'
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  );
BEGIN
  FOR v_constraint IN
    SELECT constraint_row.conname
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid =
        'public.group_edit_applications'::pg_catalog.regclass
      AND (
        constraint_row.contype = 'f'
        OR (
          constraint_row.contype = 'c'
          AND constraint_row.conkey @> ARRAY[v_status_attnum]::smallint[]
        )
      )
  LOOP
    EXECUTE pg_catalog.format(
      'ALTER TABLE public.group_edit_applications DROP CONSTRAINT %I',
      v_constraint.conname
    );
  END LOOP;
END
$replace_application_foreign_keys_and_status_check$;

ALTER TABLE public.group_edit_applications
  ADD CONSTRAINT group_edit_applications_group_id_fkey
    FOREIGN KEY (group_id) REFERENCES public.groups(id) ON DELETE CASCADE,
  ADD CONSTRAINT group_edit_applications_applicant_id_fkey
    FOREIGN KEY (applicant_id) REFERENCES auth.users(id) ON DELETE CASCADE,
  ADD CONSTRAINT group_edit_applications_reviewed_by_fkey
    FOREIGN KEY (reviewed_by) REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD CONSTRAINT group_edit_applications_status_check
    CHECK (status IN ('pending', 'approved', 'rejected'));

DROP INDEX IF EXISTS public.group_edit_applications_one_pending_per_group;
CREATE UNIQUE INDEX group_edit_applications_one_pending_per_group
  ON public.group_edit_applications (group_id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS group_edit_applications_group_created_idx
  ON public.group_edit_applications (group_id, created_at DESC);
CREATE INDEX IF NOT EXISTS group_edit_applications_applicant_created_idx
  ON public.group_edit_applications (applicant_id, created_at DESC);

ALTER TABLE public.group_edit_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.group_edit_applications FORCE ROW LEVEL SECURITY;
ALTER TABLE public.group_edit_application_operation_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.group_edit_application_operation_results FORCE ROW LEVEL SECURITY;

DO $replace_application_and_ledger_authority$
DECLARE
  v_relation_name text;
  v_relation_oid oid;
  v_relation_owner oid;
  v_column_list text;
  v_grantee record;
  v_policy record;
BEGIN
  FOREACH v_relation_name IN ARRAY ARRAY[
    'group_edit_applications',
    'group_edit_application_operation_results'
  ]::text[]
  LOOP
    v_relation_oid := pg_catalog.to_regclass('public.' || v_relation_name);
    SELECT relation.relowner INTO STRICT v_relation_owner
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = v_relation_oid;

    FOR v_grantee IN
      SELECT DISTINCT acl_entry.grantee, role_row.rolname
      FROM pg_catalog.pg_class AS relation
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
      ) AS acl_entry
      LEFT JOIN pg_catalog.pg_roles AS role_row
        ON role_row.oid = acl_entry.grantee
      WHERE relation.oid = v_relation_oid
        AND acl_entry.grantee <> v_relation_owner
    LOOP
      IF v_grantee.grantee = 0 THEN
        EXECUTE pg_catalog.format(
          'REVOKE ALL PRIVILEGES ON TABLE public.%I FROM PUBLIC',
          v_relation_name
        );
      ELSIF v_grantee.rolname IS NOT NULL THEN
        EXECUTE pg_catalog.format(
          'REVOKE ALL PRIVILEGES ON TABLE public.%I FROM %I',
          v_relation_name,
          v_grantee.rolname
        );
      END IF;
    END LOOP;

    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON TABLE public.%I '
        || 'FROM PUBLIC, anon, authenticated, service_role',
      v_relation_name
    );

    SELECT pg_catalog.string_agg(
      pg_catalog.format('%I', attribute.attname), ', ' ORDER BY attribute.attnum
    ) INTO v_column_list
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = v_relation_oid
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped;

    IF v_column_list IS NOT NULL THEN
      FOR v_grantee IN
        SELECT DISTINCT acl_entry.grantee, role_row.rolname
        FROM pg_catalog.pg_attribute AS attribute
        CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl_entry
        LEFT JOIN pg_catalog.pg_roles AS role_row
          ON role_row.oid = acl_entry.grantee
        WHERE attribute.attrelid = v_relation_oid
          AND attribute.attnum > 0
          AND NOT attribute.attisdropped
          AND acl_entry.grantee <> v_relation_owner
      LOOP
        IF v_grantee.grantee = 0 THEN
          EXECUTE pg_catalog.format(
            'REVOKE SELECT (%1$s), INSERT (%1$s), UPDATE (%1$s), REFERENCES (%1$s) '
              || 'ON TABLE public.%2$I FROM PUBLIC',
            v_column_list,
            v_relation_name
          );
        ELSIF v_grantee.rolname IS NOT NULL THEN
          EXECUTE pg_catalog.format(
            'REVOKE SELECT (%1$s), INSERT (%1$s), UPDATE (%1$s), REFERENCES (%1$s) '
              || 'ON TABLE public.%2$I FROM %3$I',
            v_column_list,
            v_relation_name,
            v_grantee.rolname
          );
        END IF;
      END LOOP;
    END IF;

    FOR v_policy IN
      SELECT policy.polname
      FROM pg_catalog.pg_policy AS policy
      WHERE policy.polrelid = v_relation_oid
    LOOP
      EXECUTE pg_catalog.format(
        'DROP POLICY %I ON public.%I',
        v_policy.polname,
        v_relation_name
      );
    END LOOP;
  END LOOP;
END
$replace_application_and_ledger_authority$;

GRANT SELECT ON TABLE public.group_edit_applications
  TO authenticated, service_role;

CREATE POLICY applicant_read
  ON public.group_edit_applications
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (applicant_id = (SELECT auth.uid()));

CREATE POLICY site_admin_read
  ON public.group_edit_applications
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.user_profiles AS profile
      WHERE profile.id = (SELECT auth.uid())
        AND profile.role = 'admin'
        AND profile.deleted_at IS NULL
        AND profile.banned_at IS NULL
        AND NOT (
          COALESCE(profile.is_banned, false)
          AND (
            profile.ban_expires_at IS NULL
            OR profile.ban_expires_at > pg_catalog.clock_timestamp()
          )
        )
    )
  );

COMMENT ON TABLE public.group_edit_application_operation_results IS
  'Permanent no-FK replay ledger for exact group-edit application operation results.';

-- Only postgres-owned security-definer boundaries may change profile fields.
-- This is not a spoofable custom GUC: a direct service_role UPDATE retains
-- current_user=service_role.  Unrelated updates such as dissolved_at and
-- member_count remain available to their existing operational paths.
DROP TRIGGER IF EXISTS trg_groups_06_guard_profile_edit ON public.groups;

CREATE OR REPLACE FUNCTION public.enforce_group_profile_edit_write()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF NEW.name IS NOT DISTINCT FROM OLD.name
    AND NEW.name_en IS NOT DISTINCT FROM OLD.name_en
    AND NEW.description IS NOT DISTINCT FROM OLD.description
    AND NEW.description_en IS NOT DISTINCT FROM OLD.description_en
    AND NEW.avatar_url IS NOT DISTINCT FROM OLD.avatar_url
    AND NEW.role_names IS NOT DISTINCT FROM OLD.role_names
    AND NEW.rules_json IS NOT DISTINCT FROM OLD.rules_json
    AND NEW.rules IS NOT DISTINCT FROM OLD.rules
    AND NEW.is_premium_only IS NOT DISTINCT FROM OLD.is_premium_only
  THEN
    RETURN NEW;
  END IF;

  IF CURRENT_USER <> 'postgres' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'group profile edits require an approved atomic application';
  END IF;
  RETURN NEW;
END
$function$;

ALTER FUNCTION public.enforce_group_profile_edit_write() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.enforce_group_profile_edit_write()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER trg_groups_06_guard_profile_edit
  BEFORE UPDATE OF
    name,
    name_en,
    description,
    description_en,
    avatar_url,
    role_names,
    rules_json,
    rules,
    is_premium_only
  ON public.groups
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_group_profile_edit_write();

DROP FUNCTION IF EXISTS public.submit_group_edit_application_atomic(
  uuid, uuid, text, text, text, text, text, jsonb, jsonb, text, boolean
) RESTRICT;
DROP FUNCTION IF EXISTS public.review_group_edit_application_atomic(
  uuid, uuid, text, text
) RESTRICT;

CREATE OR REPLACE FUNCTION public.submit_group_edit_application_atomic(
  p_actor_id uuid,
  p_group_id uuid,
  p_name text,
  p_name_en text,
  p_description text,
  p_description_en text,
  p_avatar_url text,
  p_role_names jsonb,
  p_rules_json jsonb,
  p_rules text,
  p_is_premium_only boolean,
  p_operation_id uuid
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
  v_existing_actor_id uuid;
  v_existing_fingerprint text;
  v_existing_kind text;
  v_existing_result jsonb;
  v_group public.groups%ROWTYPE;
  v_intent_fingerprint text;
  v_member_role public.member_role;
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
  v_avatar_url text := NULLIF(
    normalize(pg_catalog.btrim(COALESCE(p_avatar_url, '')), NFC),
    ''
  );
  v_rules text := NULLIF(
    normalize(pg_catalog.btrim(COALESCE(p_rules, '')), NFC),
    ''
  );
  v_result jsonb;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'service role required';
  END IF;

  -- Deployment barrier and universal first relation lock.
  LOCK TABLE public.group_edit_application_operation_results
    IN ROW EXCLUSIVE MODE;

  IF p_actor_id IS NULL OR p_group_id IS NULL OR p_operation_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;

  v_intent_fingerprint := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_array(
      'group-edit-submit:v1',
      p_group_id,
      v_name,
      v_name_en,
      v_description,
      v_description_en,
      v_avatar_url,
      p_role_names,
      p_rules_json,
      v_rules,
      p_is_premium_only
    )::text, 'UTF8')),
    'hex'
  );

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'group-edit-operation:' || p_operation_id::text,
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
  FROM public.group_edit_application_operation_results AS ledger
  WHERE ledger.operation_id = p_operation_id;

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

  IF v_name = ''
    OR p_is_premium_only IS NULL
    OR pg_catalog.char_length(v_name) > 50
    OR pg_catalog.char_length(COALESCE(v_name_en, '')) > 50
    OR pg_catalog.char_length(COALESCE(v_description, '')) > 500
    OR pg_catalog.char_length(COALESCE(v_description_en, '')) > 500
    OR pg_catalog.char_length(COALESCE(v_avatar_url, '')) > 2048
    OR (
      v_avatar_url IS NOT NULL
      AND v_avatar_url !~* '^https?://[^[:space:]]+$'
    )
    OR pg_catalog.char_length(COALESCE(v_rules, '')) > 10000
    OR pg_catalog.octet_length(COALESCE(p_role_names, '{}'::jsonb)::text) > 32768
    OR pg_catalog.octet_length(COALESCE(p_rules_json, '[]'::jsonb)::text) > 65536
    OR (CASE
      WHEN p_role_names IS NULL THEN false
      WHEN pg_catalog.jsonb_typeof(p_role_names) <> 'object' THEN true
      ELSE (
        (
          SELECT pg_catalog.array_agg(role_key.key_name ORDER BY role_key.key_name)
          FROM pg_catalog.jsonb_object_keys(p_role_names) AS role_key(key_name)
        ) IS DISTINCT FROM ARRAY['admin', 'member']::text[]
        OR EXISTS (
          SELECT 1
          FROM pg_catalog.jsonb_each(p_role_names) AS role_entry(role_key, labels)
          WHERE (CASE
            WHEN pg_catalog.jsonb_typeof(role_entry.labels) <> 'object' THEN true
            ELSE (
              SELECT pg_catalog.array_agg(label_key.key_name ORDER BY label_key.key_name)
              FROM pg_catalog.jsonb_object_keys(role_entry.labels) AS label_key(key_name)
            ) IS DISTINCT FROM ARRAY['en', 'zh']::text[]
              OR pg_catalog.jsonb_typeof(role_entry.labels -> 'zh') <> 'string'
              OR pg_catalog.jsonb_typeof(role_entry.labels -> 'en') <> 'string'
              OR pg_catalog.char_length(role_entry.labels ->> 'zh') > 50
              OR pg_catalog.char_length(role_entry.labels ->> 'en') > 50
              OR pg_catalog.btrim(role_entry.labels ->> 'zh') <>
                   role_entry.labels ->> 'zh'
              OR pg_catalog.btrim(role_entry.labels ->> 'en') <>
                   role_entry.labels ->> 'en'
              OR normalize(role_entry.labels ->> 'zh', NFC) <>
                   role_entry.labels ->> 'zh'
              OR normalize(role_entry.labels ->> 'en', NFC) <>
                   role_entry.labels ->> 'en'
          END)
        )
      )
    END)
    OR (CASE
      WHEN p_rules_json IS NULL THEN false
      WHEN pg_catalog.jsonb_typeof(p_rules_json) <> 'array' THEN true
      ELSE pg_catalog.jsonb_array_length(p_rules_json) > 100
        OR EXISTS (
          SELECT 1
          FROM pg_catalog.jsonb_array_elements(p_rules_json) AS rule_entry(rule_value)
          WHERE (CASE
            WHEN pg_catalog.jsonb_typeof(rule_entry.rule_value) <> 'object' THEN true
            ELSE (
              SELECT pg_catalog.array_agg(rule_key.key_name ORDER BY rule_key.key_name)
              FROM pg_catalog.jsonb_object_keys(rule_entry.rule_value) AS rule_key(key_name)
            ) IS DISTINCT FROM ARRAY['en', 'zh']::text[]
              OR pg_catalog.jsonb_typeof(rule_entry.rule_value -> 'zh') <> 'string'
              OR pg_catalog.jsonb_typeof(rule_entry.rule_value -> 'en') <> 'string'
              OR pg_catalog.char_length(rule_entry.rule_value ->> 'zh') > 2000
              OR pg_catalog.char_length(rule_entry.rule_value ->> 'en') > 2000
              OR pg_catalog.btrim(rule_entry.rule_value ->> 'zh') <>
                   rule_entry.rule_value ->> 'zh'
              OR pg_catalog.btrim(rule_entry.rule_value ->> 'en') <>
                   rule_entry.rule_value ->> 'en'
              OR normalize(rule_entry.rule_value ->> 'zh', NFC) <>
                   rule_entry.rule_value ->> 'zh'
              OR normalize(rule_entry.rule_value ->> 'en', NFC) <>
                   rule_entry.rule_value ->> 'en'
          END)
        )
    END)
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;

  PERFORM 1
  FROM auth.users AS auth_user
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

  SELECT target_group.*
  INTO v_group
  FROM public.groups AS target_group
  WHERE target_group.id = p_group_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;
  IF v_group.dissolved_at IS NOT NULL THEN
    RETURN pg_catalog.jsonb_build_object('status', 'dissolved');
  END IF;

  SELECT member.role
  INTO v_member_role
  FROM public.group_members AS member
  WHERE member.group_id = p_group_id
    AND member.user_id = p_actor_id
  FOR SHARE;
  IF NOT FOUND OR NOT (
    v_member_role = 'owner'::public.member_role
    OR (
      v_member_role = 'admin'::public.member_role
      AND v_group.created_by = p_actor_id
    )
  ) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'forbidden');
  END IF;

  IF p_is_premium_only IS DISTINCT FROM
    COALESCE(v_group.is_premium_only, false)
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'premium_change_unsupported'
    );
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.group_edit_applications AS pending_application
    WHERE pending_application.group_id = p_group_id
      AND pending_application.status = 'pending'
  ) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'pending_exists');
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'group-name:' || pg_catalog.lower(v_name),
      0
    )
  );
  IF EXISTS (
    SELECT 1
    FROM public.groups AS existing_group
    WHERE existing_group.id <> p_group_id
      AND pg_catalog.lower(normalize(existing_group.name, NFC)) =
        pg_catalog.lower(v_name)
  ) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'name_taken');
  END IF;

  INSERT INTO public.group_edit_applications (
    group_id,
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
    p_group_id,
    p_actor_id,
    v_name,
    v_name_en,
    v_description,
    v_description_en,
    v_avatar_url,
    p_role_names,
    p_rules_json,
    v_rules,
    p_is_premium_only,
    'pending'
  )
  RETURNING id, created_at INTO v_application_id, v_created_at;

  INSERT INTO public.group_audit_log (
    group_id, actor_id, action, target_id, details
  ) VALUES (
    p_group_id,
    p_actor_id,
    'edit_application_submitted',
    v_application_id,
    pg_catalog.jsonb_build_object(
      'operation_id', p_operation_id,
      'proposed_name', v_name
    )
  );

  v_result := pg_catalog.jsonb_build_object(
    'status', 'submitted',
    'operation_id', p_operation_id,
    'application', pg_catalog.jsonb_build_object(
      'id', v_application_id,
      'group_id', p_group_id,
      'applicant_id', p_actor_id,
      'name', v_name,
      'name_en', v_name_en,
      'description', v_description,
      'description_en', v_description_en,
      'avatar_url', v_avatar_url,
      'role_names', p_role_names,
      'rules_json', p_rules_json,
      'rules', v_rules,
      'is_premium_only', p_is_premium_only,
      'status', 'pending',
      'created_at', v_created_at
    )
  );

  INSERT INTO public.group_edit_application_operation_results (
    operation_id, operation_kind, actor_id, intent_fingerprint, result
  ) VALUES (
    p_operation_id, 'submit', p_actor_id, v_intent_fingerprint, v_result
  );

  RETURN v_result || pg_catalog.jsonb_build_object('applied', true);
END
$function$;

ALTER FUNCTION public.submit_group_edit_application_atomic(
  uuid, uuid, text, text, text, text, text, jsonb, jsonb, text, boolean, uuid
) OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.review_group_edit_application_atomic(
  p_reviewer_id uuid,
  p_application_id uuid,
  p_decision text,
  p_reject_reason text,
  p_operation_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_application public.group_edit_applications%ROWTYPE;
  v_candidate_applicant_id uuid;
  v_candidate_group_id uuid;
  v_decision text := pg_catalog.lower(
    pg_catalog.btrim(COALESCE(p_decision, ''))
  );
  v_effective_premium boolean;
  v_existing_actor_id uuid;
  v_existing_fingerprint text;
  v_existing_kind text;
  v_existing_result jsonb;
  v_group public.groups%ROWTYPE;
  v_group_name text;
  v_intent_fingerprint text;
  v_locked_auth_ids uuid[] := ARRAY[]::uuid[];
  v_member_role public.member_role;
  v_name text;
  v_name_en text;
  v_description text;
  v_description_en text;
  v_avatar_url text;
  v_rules text;
  v_notification_hex text;
  v_notification_id uuid;
  v_notification_message text;
  v_reject_reason text := NULLIF(
    normalize(pg_catalog.btrim(COALESCE(p_reject_reason, '')), NFC),
    ''
  );
  v_required_auth_id uuid;
  v_role_names jsonb;
  v_result jsonb;
  v_rules_json jsonb;
  v_reviewed_at timestamptz;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'service role required';
  END IF;

  LOCK TABLE public.group_edit_application_operation_results
    IN ROW EXCLUSIVE MODE;

  IF p_reviewer_id IS NULL
    OR p_application_id IS NULL
    OR p_operation_id IS NULL
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;

  v_intent_fingerprint := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_array(
      'group-edit-review:v1',
      p_application_id,
      v_decision,
      v_reject_reason
    )::text, 'UTF8')),
    'hex'
  );

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'group-edit-operation:' || p_operation_id::text,
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
  FROM public.group_edit_application_operation_results AS ledger
  WHERE ledger.operation_id = p_operation_id;

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

  IF v_decision NOT IN ('approve', 'reject')
    OR pg_catalog.char_length(COALESCE(v_reject_reason, '')) > 500
    OR (v_decision = 'approve' AND v_reject_reason IS NOT NULL)
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;

  SELECT application.group_id, application.applicant_id
  INTO v_candidate_group_id, v_candidate_applicant_id
  FROM public.group_edit_applications AS application
  WHERE application.id = p_application_id;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  -- Auth/profile rows are acquired in UUID order so reviewer/applicant role
  -- overlap cannot invert locks across concurrent reviews or hard deletion.
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
    RETURN pg_catalog.jsonb_build_object('status', 'reviewer_inactive');
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
    RETURN pg_catalog.jsonb_build_object('status', 'reviewer_inactive');
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.user_profiles AS reviewer
    WHERE reviewer.id = p_reviewer_id
      AND reviewer.role = 'admin'
  ) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'reviewer_unauthorized');
  END IF;

  SELECT target_group.*
  INTO v_group
  FROM public.groups AS target_group
  WHERE target_group.id = v_candidate_group_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  SELECT application.*
  INTO v_application
  FROM public.group_edit_applications AS application
  WHERE application.id = p_application_id
    AND application.group_id = v_candidate_group_id
    AND application.applicant_id = v_candidate_applicant_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;
  IF v_application.status <> 'pending' THEN
    RETURN pg_catalog.jsonb_build_object('status', 'already_processed');
  END IF;

  v_group_name := normalize(
    pg_catalog.btrim(COALESCE(v_application.name, v_group.name, 'Group')),
    NFC
  );
  IF v_group_name = '' THEN
    v_group_name := 'Group';
  END IF;
  v_group_name := pg_catalog.left(v_group_name, 50);
  v_reviewed_at := pg_catalog.clock_timestamp();

  IF v_decision = 'approve' THEN
    IF v_group.dissolved_at IS NOT NULL THEN
      RETURN pg_catalog.jsonb_build_object('status', 'dissolved');
    END IF;

    SELECT member.role
    INTO v_member_role
    FROM public.group_members AS member
    WHERE member.group_id = v_candidate_group_id
      AND member.user_id = v_candidate_applicant_id
    FOR SHARE;
    IF NOT FOUND OR NOT (
      v_member_role = 'owner'::public.member_role
      OR (
        v_member_role = 'admin'::public.member_role
        AND v_group.created_by = v_candidate_applicant_id
      )
    ) THEN
      RETURN pg_catalog.jsonb_build_object('status', 'owner_changed');
    END IF;

    IF NOT v_candidate_applicant_id = ANY (v_locked_auth_ids) OR NOT EXISTS (
      SELECT 1
      FROM public.user_profiles AS applicant
      WHERE applicant.id = v_candidate_applicant_id
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

    v_name := normalize(
      pg_catalog.btrim(COALESCE(v_application.name, v_group.name, '')),
      NFC
    );
    v_name_en := NULLIF(
      normalize(pg_catalog.btrim(COALESCE(
        v_application.name_en, v_group.name_en, ''
      )), NFC),
      ''
    );
    v_description := NULLIF(
      normalize(pg_catalog.btrim(COALESCE(
        v_application.description, v_group.description, ''
      )), NFC),
      ''
    );
    v_description_en := NULLIF(
      normalize(pg_catalog.btrim(COALESCE(
        v_application.description_en, v_group.description_en, ''
      )), NFC),
      ''
    );
    v_avatar_url := NULLIF(
      normalize(pg_catalog.btrim(COALESCE(
        v_application.avatar_url, v_group.avatar_url, ''
      )), NFC),
      ''
    );
    v_rules := NULLIF(
      normalize(pg_catalog.btrim(COALESCE(
        v_application.rules, v_group.rules, ''
      )), NFC),
      ''
    );
    v_role_names := COALESCE(v_application.role_names, v_group.role_names);
    v_rules_json := COALESCE(v_application.rules_json, v_group.rules_json);
    v_effective_premium := COALESCE(
      v_application.is_premium_only,
      v_group.is_premium_only,
      false
    );

    IF v_name = ''
      OR pg_catalog.char_length(v_name) > 50
      OR pg_catalog.char_length(COALESCE(v_name_en, '')) > 50
      OR pg_catalog.char_length(COALESCE(v_description, '')) > 500
      OR pg_catalog.char_length(COALESCE(v_description_en, '')) > 500
      OR pg_catalog.char_length(COALESCE(v_avatar_url, '')) > 2048
      OR (
        v_avatar_url IS NOT NULL
        AND v_avatar_url !~* '^https?://[^[:space:]]+$'
      )
      OR pg_catalog.char_length(COALESCE(v_rules, '')) > 10000
      OR pg_catalog.octet_length(
        COALESCE(v_role_names, '{}'::jsonb)::text
      ) > 32768
      OR pg_catalog.octet_length(
        COALESCE(v_rules_json, '[]'::jsonb)::text
      ) > 65536
      OR (CASE
        WHEN v_role_names IS NULL THEN false
        WHEN pg_catalog.jsonb_typeof(v_role_names) <> 'object' THEN true
        ELSE (
          (
            SELECT pg_catalog.array_agg(role_key.key_name ORDER BY role_key.key_name)
            FROM pg_catalog.jsonb_object_keys(v_role_names) AS role_key(key_name)
          ) IS DISTINCT FROM ARRAY['admin', 'member']::text[]
          OR EXISTS (
            SELECT 1
            FROM pg_catalog.jsonb_each(v_role_names) AS role_entry(role_key, labels)
            WHERE (CASE
              WHEN pg_catalog.jsonb_typeof(role_entry.labels) <> 'object' THEN true
              ELSE (
                SELECT pg_catalog.array_agg(label_key.key_name ORDER BY label_key.key_name)
                FROM pg_catalog.jsonb_object_keys(role_entry.labels) AS label_key(key_name)
              ) IS DISTINCT FROM ARRAY['en', 'zh']::text[]
                OR pg_catalog.jsonb_typeof(role_entry.labels -> 'zh') <> 'string'
                OR pg_catalog.jsonb_typeof(role_entry.labels -> 'en') <> 'string'
                OR pg_catalog.char_length(role_entry.labels ->> 'zh') > 50
                OR pg_catalog.char_length(role_entry.labels ->> 'en') > 50
                OR pg_catalog.btrim(role_entry.labels ->> 'zh') <>
                     role_entry.labels ->> 'zh'
                OR pg_catalog.btrim(role_entry.labels ->> 'en') <>
                     role_entry.labels ->> 'en'
                OR normalize(role_entry.labels ->> 'zh', NFC) <>
                     role_entry.labels ->> 'zh'
                OR normalize(role_entry.labels ->> 'en', NFC) <>
                     role_entry.labels ->> 'en'
            END)
          )
        )
      END)
      OR (CASE
        WHEN v_rules_json IS NULL THEN false
        WHEN pg_catalog.jsonb_typeof(v_rules_json) <> 'array' THEN true
        ELSE pg_catalog.jsonb_array_length(v_rules_json) > 100
          OR EXISTS (
            SELECT 1
            FROM pg_catalog.jsonb_array_elements(v_rules_json) AS rule_entry(rule_value)
            WHERE (CASE
              WHEN pg_catalog.jsonb_typeof(rule_entry.rule_value) <> 'object' THEN true
              ELSE (
                SELECT pg_catalog.array_agg(rule_key.key_name ORDER BY rule_key.key_name)
                FROM pg_catalog.jsonb_object_keys(rule_entry.rule_value) AS rule_key(key_name)
              ) IS DISTINCT FROM ARRAY['en', 'zh']::text[]
                OR pg_catalog.jsonb_typeof(rule_entry.rule_value -> 'zh') <> 'string'
                OR pg_catalog.jsonb_typeof(rule_entry.rule_value -> 'en') <> 'string'
                OR pg_catalog.char_length(rule_entry.rule_value ->> 'zh') > 2000
                OR pg_catalog.char_length(rule_entry.rule_value ->> 'en') > 2000
                OR pg_catalog.btrim(rule_entry.rule_value ->> 'zh') <>
                     rule_entry.rule_value ->> 'zh'
                OR pg_catalog.btrim(rule_entry.rule_value ->> 'en') <>
                     rule_entry.rule_value ->> 'en'
                OR normalize(rule_entry.rule_value ->> 'zh', NFC) <>
                     rule_entry.rule_value ->> 'zh'
                OR normalize(rule_entry.rule_value ->> 'en', NFC) <>
                     rule_entry.rule_value ->> 'en'
            END)
          )
      END)
    THEN
      RETURN pg_catalog.jsonb_build_object('status', 'invalid');
    END IF;

    IF v_effective_premium IS DISTINCT FROM
      COALESCE(v_group.is_premium_only, false)
    THEN
      RETURN pg_catalog.jsonb_build_object(
        'status', 'premium_change_unsupported'
      );
    END IF;

    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'group-name:' || pg_catalog.lower(v_name),
        0
      )
    );
    IF EXISTS (
      SELECT 1
      FROM public.groups AS existing_group
      WHERE existing_group.id <> v_candidate_group_id
        AND pg_catalog.lower(normalize(existing_group.name, NFC)) =
          pg_catalog.lower(v_name)
    ) THEN
      RETURN pg_catalog.jsonb_build_object('status', 'name_taken');
    END IF;

    UPDATE public.groups AS target_group
    SET name = v_name,
        name_en = v_name_en,
        description = v_description,
        description_en = v_description_en,
        avatar_url = v_avatar_url,
        role_names = v_role_names,
        rules_json = v_rules_json,
        rules = v_rules,
        is_premium_only = v_effective_premium,
        updated_at = v_reviewed_at
    WHERE target_group.id = v_candidate_group_id;

    UPDATE public.group_edit_applications AS application
    SET status = 'approved',
        reject_reason = NULL,
        reviewed_at = v_reviewed_at,
        reviewed_by = p_reviewer_id
    WHERE application.id = p_application_id;

    v_group_name := v_name;
    v_result := pg_catalog.jsonb_build_object(
      'status', 'approved',
      'operation_id', p_operation_id,
      'application_id', p_application_id,
      'applicant_id', v_candidate_applicant_id,
      'group_id', v_candidate_group_id,
      'group_name', v_group_name,
      'reviewed_at', v_reviewed_at
    );
  ELSE
    UPDATE public.group_edit_applications AS application
    SET status = 'rejected',
        reject_reason = v_reject_reason,
        reviewed_at = v_reviewed_at,
        reviewed_by = p_reviewer_id
    WHERE application.id = p_application_id;

    v_result := pg_catalog.jsonb_build_object(
      'status', 'rejected',
      'operation_id', p_operation_id,
      'application_id', p_application_id,
      'applicant_id', v_candidate_applicant_id,
      'group_id', v_candidate_group_id,
      'group_name', v_group_name,
      'reviewed_at', v_reviewed_at,
      'reject_reason', v_reject_reason
    );
  END IF;

  INSERT INTO public.group_audit_log (
    group_id, actor_id, action, target_id, details
  ) VALUES (
    v_candidate_group_id,
    p_reviewer_id,
    CASE v_decision
      WHEN 'approve' THEN 'edit_application_approved'
      ELSE 'edit_application_rejected'
    END,
    p_application_id,
    pg_catalog.jsonb_build_object(
      'operation_id', p_operation_id,
      'applicant_id', v_candidate_applicant_id,
      'reason', v_reject_reason
    )
  );

  v_notification_hex := pg_catalog.md5(
    'group-edit-application-notification:' || p_operation_id::text
  );
  v_notification_id := (
    pg_catalog.substr(v_notification_hex, 1, 8) || '-' ||
    pg_catalog.substr(v_notification_hex, 9, 4) || '-' ||
    pg_catalog.substr(v_notification_hex, 13, 4) || '-' ||
    pg_catalog.substr(v_notification_hex, 17, 4) || '-' ||
    pg_catalog.substr(v_notification_hex, 21, 12)
  )::uuid;
  v_notification_message := pg_catalog.left(
    CASE
      WHEN v_decision = 'approve' THEN
        'Your group information update for "' || v_group_name || '" was approved'
      WHEN v_reject_reason IS NULL THEN
        'Your group information update for "' || v_group_name || '" was rejected'
      ELSE
        'Your group information update for "' || v_group_name ||
          '" was rejected: ' || v_reject_reason
    END,
    500
  );

  INSERT INTO public.notifications (
    id, user_id, type, title, message, link, actor_id, reference_id, read
  ) VALUES (
    v_notification_id,
    v_candidate_applicant_id,
    'system',
    CASE
      WHEN v_decision = 'approve' THEN 'Group information update approved'
      ELSE 'Group information update rejected'
    END,
    v_notification_message,
    '/groups/' || v_candidate_group_id::text,
    p_reviewer_id,
    p_application_id,
    false
  );

  INSERT INTO public.group_edit_application_operation_results (
    operation_id, operation_kind, actor_id, intent_fingerprint, result
  ) VALUES (
    p_operation_id,
    v_decision,
    p_reviewer_id,
    v_intent_fingerprint,
    v_result
  );

  RETURN v_result || pg_catalog.jsonb_build_object('applied', true);
END
$function$;

ALTER FUNCTION public.review_group_edit_application_atomic(
  uuid, uuid, text, text, uuid
) OWNER TO postgres;

DO $replace_function_acl$
DECLARE
  v_function pg_catalog.regprocedure;
  v_grantee record;
BEGIN
  FOREACH v_function IN ARRAY ARRAY[
    'public.submit_group_edit_application_atomic(uuid,uuid,text,text,text,text,text,jsonb,jsonb,text,boolean,uuid)'::pg_catalog.regprocedure,
    'public.review_group_edit_application_atomic(uuid,uuid,text,text,uuid)'::pg_catalog.regprocedure
  ]
  LOOP
    FOR v_grantee IN
      SELECT DISTINCT acl_entry.grantee, role_row.rolname
      FROM pg_catalog.pg_proc AS function_row
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(function_row.proacl, pg_catalog.acldefault('f', function_row.proowner))
      ) AS acl_entry
      LEFT JOIN pg_catalog.pg_roles AS role_row
        ON role_row.oid = acl_entry.grantee
      WHERE function_row.oid = v_function
        AND acl_entry.grantee <> function_row.proowner
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

REVOKE ALL ON FUNCTION public.submit_group_edit_application_atomic(
  uuid, uuid, text, text, text, text, text, jsonb, jsonb, text, boolean, uuid
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.review_group_edit_application_atomic(
  uuid, uuid, text, text, uuid
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.submit_group_edit_application_atomic(
  uuid, uuid, text, text, text, text, text, jsonb, jsonb, text, boolean, uuid
) TO service_role;
GRANT EXECUTE ON FUNCTION public.review_group_edit_application_atomic(
  uuid, uuid, text, text, uuid
) TO service_role;

DO $seal_sources$
DECLARE
  v_submit pg_catalog.regprocedure :=
    'public.submit_group_edit_application_atomic(uuid,uuid,text,text,text,text,text,jsonb,jsonb,text,boolean,uuid)'::pg_catalog.regprocedure;
  v_review pg_catalog.regprocedure :=
    'public.review_group_edit_application_atomic(uuid,uuid,text,text,uuid)'::pg_catalog.regprocedure;
  v_guard pg_catalog.regprocedure :=
    'public.enforce_group_profile_edit_write()'::pg_catalog.regprocedure;
BEGIN
  EXECUTE pg_catalog.format(
    'COMMENT ON FUNCTION %s IS %L',
    v_submit,
    'group-edit-application-operation-replay:submit:v1:' || (
      SELECT pg_catalog.md5(function_row.prosrc)
      FROM pg_catalog.pg_proc AS function_row WHERE function_row.oid = v_submit
    )
  );
  EXECUTE pg_catalog.format(
    'COMMENT ON FUNCTION %s IS %L',
    v_review,
    'group-edit-application-operation-replay:review:v1:' || (
      SELECT pg_catalog.md5(function_row.prosrc)
      FROM pg_catalog.pg_proc AS function_row WHERE function_row.oid = v_review
    )
  );
  EXECUTE pg_catalog.format(
    'COMMENT ON FUNCTION %s IS %L',
    v_guard,
    'group-edit-application-operation-replay:profile-guard:v1:' || (
      SELECT pg_catalog.md5(function_row.prosrc)
      FROM pg_catalog.pg_proc AS function_row WHERE function_row.oid = v_guard
    )
  );
END
$seal_sources$;

DO $postflight$
DECLARE
  v_edit pg_catalog.regclass :=
    'public.group_edit_applications'::pg_catalog.regclass;
  v_ledger pg_catalog.regclass :=
    'public.group_edit_application_operation_results'::pg_catalog.regclass;
  v_groups pg_catalog.regclass := 'public.groups'::pg_catalog.regclass;
  v_submit pg_catalog.regprocedure :=
    'public.submit_group_edit_application_atomic(uuid,uuid,text,text,text,text,text,jsonb,jsonb,text,boolean,uuid)'::pg_catalog.regprocedure;
  v_review pg_catalog.regprocedure :=
    'public.review_group_edit_application_atomic(uuid,uuid,text,text,uuid)'::pg_catalog.regprocedure;
  v_guard pg_catalog.regprocedure :=
    'public.enforce_group_profile_edit_write()'::pg_catalog.regprocedure;
  v_postgres_oid oid := (
    SELECT role_row.oid FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'postgres'
  );
  v_anon_oid oid := (
    SELECT role_row.oid FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'anon'
  );
  v_authenticated_oid oid := (
    SELECT role_row.oid FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'authenticated'
  );
  v_service_oid oid := (
    SELECT role_row.oid FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'service_role'
  );
  v_profile_attnums smallint[];
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid IN (v_edit, v_ledger)
      AND (
        relation.relkind <> 'r'
        OR relation.relpersistence <> 'p'
        OR relation.relispartition
        OR relation.relowner <> v_postgres_oid
        OR NOT relation.relrowsecurity
        OR NOT relation.relforcerowsecurity
      )
  ) OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_inherits AS inheritance
    WHERE inheritance.inhrelid IN (v_edit, v_ledger)
       OR inheritance.inhparent IN (v_edit, v_ledger)
  ) THEN
    RAISE EXCEPTION 'group-edit application/ledger relation authority drifted';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = v_ledger
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  ) <> 6 OR EXISTS (
    SELECT 1
    FROM (
      VALUES
        (1, 'operation_id', 'uuid'::pg_catalog.regtype, true, NULL::text),
        (2, 'operation_kind', 'text'::pg_catalog.regtype, true, NULL::text),
        (3, 'actor_id', 'uuid'::pg_catalog.regtype, true, NULL::text),
        (4, 'intent_fingerprint', 'text'::pg_catalog.regtype, true, NULL::text),
        (5, 'result', 'jsonb'::pg_catalog.regtype, true, NULL::text),
        (6, 'created_at', 'timestamptz'::pg_catalog.regtype, true, 'statement_timestamp()')
    ) AS expected_column(
      ordinal_position, column_name, type_oid, required_not_null, default_expression
    )
    LEFT JOIN pg_catalog.pg_attribute AS attribute
      ON attribute.attrelid = v_ledger
     AND attribute.attnum = expected_column.ordinal_position
     AND NOT attribute.attisdropped
    LEFT JOIN pg_catalog.pg_attrdef AS column_default
      ON column_default.adrelid = attribute.attrelid
     AND column_default.adnum = attribute.attnum
    WHERE attribute.attname IS DISTINCT FROM expected_column.column_name::name
       OR attribute.atttypid IS DISTINCT FROM expected_column.type_oid
       OR attribute.attnotnull IS DISTINCT FROM expected_column.required_not_null
       OR attribute.attidentity <> ''
       OR attribute.attgenerated <> ''
       OR pg_catalog.pg_get_expr(
         column_default.adbin, column_default.adrelid, true
       ) IS DISTINCT FROM expected_column.default_expression
  ) OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = v_ledger
      AND constraint_row.contype = 'f'
  ) OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = v_ledger
      AND NOT trigger_row.tgisinternal
  ) OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = v_ledger
  ) <> 4 OR EXISTS (
    SELECT 1
    FROM (
      VALUES
        (
          'group_edit_application_operation_results_pkey',
          'p'::"char",
          ARRAY[1]::smallint[],
          'f59b9d798d6d843ea6ea10575b2ae406'
        ),
        (
          'group_edit_application_operation_kind_check',
          'c'::"char",
          ARRAY[2]::smallint[],
          '03985b635e9ce1e4a9b44a74324ebad5'
        ),
        (
          'group_edit_application_operation_fingerprint_check',
          'c'::"char",
          ARRAY[4]::smallint[],
          '2890640fbde1367b9d33c9f9aa039e1e'
        ),
        (
          'group_edit_application_operation_result_check',
          'c'::"char",
          ARRAY[5, 1, 2]::smallint[],
          'b6fc362861e36b70fca613e8caf43568'
        )
    ) AS expected_constraint(
      constraint_name, constraint_type, key_columns, definition_md5
    )
    LEFT JOIN pg_catalog.pg_constraint AS constraint_row
      ON constraint_row.conrelid = v_ledger
     AND constraint_row.conname = expected_constraint.constraint_name
    WHERE constraint_row.oid IS NULL
       OR constraint_row.contype <> expected_constraint.constraint_type
       OR constraint_row.conkey IS DISTINCT FROM expected_constraint.key_columns
       OR NOT constraint_row.convalidated
       OR constraint_row.condeferrable
       OR constraint_row.condeferred
       OR constraint_row.confrelid <> 0
       OR pg_catalog.md5(
         pg_catalog.pg_get_constraintdef(constraint_row.oid, true)
       ) IS DISTINCT FROM expected_constraint.definition_md5
  ) OR pg_catalog.obj_description(v_ledger, 'pg_class') IS DISTINCT FROM
    'Permanent no-FK replay ledger for exact group-edit application operation results.'
  THEN
    RAISE EXCEPTION 'group-edit replay ledger catalog is not exact';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = v_edit
      AND NOT trigger_row.tgisinternal
  ) <> 0 OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = v_edit
      AND constraint_row.contype = 'f'
      AND constraint_row.conname NOT IN (
        'group_edit_applications_group_id_fkey',
        'group_edit_applications_applicant_id_fkey',
        'group_edit_applications_reviewed_by_fkey'
      )
  ) OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = v_edit
      AND constraint_row.contype = 'f'
  ) <> 3 OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = v_edit
      AND constraint_row.conname = 'group_edit_applications_group_id_fkey'
      AND constraint_row.contype = 'f'
      AND constraint_row.conkey = ARRAY[(
        SELECT attribute.attnum
        FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid = v_edit
          AND attribute.attname = 'group_id'
          AND attribute.attnum > 0
          AND NOT attribute.attisdropped
      )]::smallint[]
      AND constraint_row.confrelid = 'public.groups'::pg_catalog.regclass
      AND constraint_row.confkey = ARRAY[(
        SELECT attribute.attnum
        FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid = 'public.groups'::pg_catalog.regclass
          AND attribute.attname = 'id'
          AND attribute.attnum > 0
          AND NOT attribute.attisdropped
      )]::smallint[]
      AND constraint_row.confdeltype = 'c'
      AND constraint_row.confupdtype = 'a'
      AND constraint_row.confmatchtype = 's'
      AND constraint_row.convalidated
      AND NOT constraint_row.condeferrable
      AND NOT constraint_row.condeferred
      AND pg_catalog.md5(
        pg_catalog.pg_get_constraintdef(constraint_row.oid, true)
      ) = 'defddb2a04cdd509ddc2b0e1b549c229'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = v_edit
      AND constraint_row.conname = 'group_edit_applications_applicant_id_fkey'
      AND constraint_row.contype = 'f'
      AND constraint_row.conkey = ARRAY[(
        SELECT attribute.attnum
        FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid = v_edit
          AND attribute.attname = 'applicant_id'
          AND attribute.attnum > 0
          AND NOT attribute.attisdropped
      )]::smallint[]
      AND constraint_row.confrelid = 'auth.users'::pg_catalog.regclass
      AND constraint_row.confkey = ARRAY[(
        SELECT attribute.attnum
        FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid = 'auth.users'::pg_catalog.regclass
          AND attribute.attname = 'id'
          AND attribute.attnum > 0
          AND NOT attribute.attisdropped
      )]::smallint[]
      AND constraint_row.confdeltype = 'c'
      AND constraint_row.confupdtype = 'a'
      AND constraint_row.confmatchtype = 's'
      AND constraint_row.convalidated
      AND NOT constraint_row.condeferrable
      AND NOT constraint_row.condeferred
      AND pg_catalog.md5(
        pg_catalog.pg_get_constraintdef(constraint_row.oid, true)
      ) = '94ee4f189bf4747599fdb14549916313'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = v_edit
      AND constraint_row.conname = 'group_edit_applications_reviewed_by_fkey'
      AND constraint_row.contype = 'f'
      AND constraint_row.conkey = ARRAY[(
        SELECT attribute.attnum
        FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid = v_edit
          AND attribute.attname = 'reviewed_by'
          AND attribute.attnum > 0
          AND NOT attribute.attisdropped
      )]::smallint[]
      AND constraint_row.confrelid = 'auth.users'::pg_catalog.regclass
      AND constraint_row.confkey = ARRAY[(
        SELECT attribute.attnum
        FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid = 'auth.users'::pg_catalog.regclass
          AND attribute.attname = 'id'
          AND attribute.attnum > 0
          AND NOT attribute.attisdropped
      )]::smallint[]
      AND constraint_row.confdeltype = 'n'
      AND constraint_row.confupdtype = 'a'
      AND constraint_row.confmatchtype = 's'
      AND constraint_row.convalidated
      AND NOT constraint_row.condeferrable
      AND NOT constraint_row.condeferred
      AND pg_catalog.md5(
        pg_catalog.pg_get_constraintdef(constraint_row.oid, true)
      ) = 'f64ec06d4f9bb4a4421251b98777440c'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = v_edit
      AND constraint_row.conname = 'group_edit_applications_status_check'
      AND constraint_row.contype = 'c'
      AND constraint_row.conkey = ARRAY[(
        SELECT attribute.attnum
        FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid = v_edit
          AND attribute.attname = 'status'
          AND attribute.attnum > 0
          AND NOT attribute.attisdropped
      )]::smallint[]
      AND constraint_row.convalidated
      AND NOT constraint_row.condeferrable
      AND NOT constraint_row.condeferred
      AND pg_catalog.md5(
        pg_catalog.pg_get_constraintdef(constraint_row.oid, true)
      ) = '82461112861cc083f2ac92a9d1a32925'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index AS index_row
    JOIN pg_catalog.pg_class AS index_relation
      ON index_relation.oid = index_row.indexrelid
    WHERE index_row.indrelid = v_edit
      AND index_relation.relname =
        'group_edit_applications_one_pending_per_group'
      AND index_row.indisunique
      AND NOT index_row.indisprimary
      AND index_row.indisvalid
      AND index_row.indisready
      AND index_row.indislive
      AND index_row.indnkeyatts = 1
      AND index_row.indnatts = 1
      AND index_row.indkey::text = (
        SELECT attribute.attnum
        FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid = v_edit
          AND attribute.attname = 'group_id'
          AND attribute.attnum > 0
          AND NOT attribute.attisdropped
      )::text
      AND index_row.indexprs IS NULL
      AND pg_catalog.pg_get_expr(index_row.indpred, index_row.indrelid, true) =
        'status = ''pending''::text'
  ) THEN
    RAISE EXCEPTION 'group-edit application state catalog is incomplete';
  END IF;

  -- Only authenticated/service_role can read applications; no nonowner can
  -- mutate either applications or the permanent ledger.
  IF NOT pg_catalog.has_table_privilege('authenticated', v_edit, 'SELECT')
    OR NOT pg_catalog.has_table_privilege('service_role', v_edit, 'SELECT')
    OR pg_catalog.has_table_privilege('anon', v_edit, 'SELECT')
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.unnest(
        ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']::text[]
      ) AS privilege(privilege_type)
      CROSS JOIN pg_catalog.unnest(
        ARRAY['anon', 'authenticated', 'service_role']::name[]
      ) AS grantee(role_name)
      WHERE pg_catalog.has_table_privilege(
        grantee.role_name, v_edit, privilege.privilege_type
      )
    ) OR EXISTS (
      SELECT 1
      FROM pg_catalog.unnest(
        ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']::text[]
      ) AS privilege(privilege_type)
      CROSS JOIN pg_catalog.unnest(
        ARRAY['anon', 'authenticated', 'service_role']::name[]
      ) AS grantee(role_name)
      WHERE pg_catalog.has_table_privilege(
        grantee.role_name, v_ledger, privilege.privilege_type
      )
    ) OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS relation
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
      ) AS acl_entry
      WHERE relation.oid IN (v_edit, v_ledger)
        AND acl_entry.grantee <> relation.relowner
        AND (
          relation.oid <> v_edit
          OR acl_entry.grantee NOT IN (v_authenticated_oid, v_service_oid)
          OR acl_entry.privilege_type <> 'SELECT'
          OR acl_entry.is_grantable
          OR acl_entry.grantor <> relation.relowner
        )
    ) OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_attribute AS attribute
      CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl_entry
      WHERE attribute.attrelid IN (v_edit, v_ledger)
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
        AND acl_entry.grantee <> v_postgres_oid
    )
  THEN
    RAISE EXCEPTION 'group-edit application/ledger ACL is not exact';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = v_edit
  ) <> 2 OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = v_edit
      AND policy.polname = 'applicant_read'
      AND policy.polcmd = 'r'
      AND policy.polroles = ARRAY[v_authenticated_oid]::oid[]
      AND policy.polpermissive
      AND policy.polwithcheck IS NULL
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = v_edit
      AND policy.polname = 'site_admin_read'
      AND policy.polcmd = 'r'
      AND policy.polroles = ARRAY[v_authenticated_oid]::oid[]
      AND policy.polpermissive
      AND policy.polwithcheck IS NULL
  ) OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = v_ledger
  ) THEN
    RAISE EXCEPTION 'group-edit application/ledger RLS policy set is not exact';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.pronamespace = 'public'::pg_catalog.regnamespace
      AND function_row.proname IN (
        'submit_group_edit_application_atomic',
        'review_group_edit_application_atomic'
      )
      AND function_row.oid NOT IN (v_submit, v_review)
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid IN (v_submit, v_review)
      AND (
        function_row.proowner <> v_postgres_oid
        OR NOT function_row.prosecdef
        OR function_row.provolatile <> 'v'
        OR function_row.prokind <> 'f'
        OR function_row.prorettype <> 'jsonb'::pg_catalog.regtype
        OR function_row.proleakproof
        OR function_row.proconfig IS DISTINCT FROM
          ARRAY['search_path=pg_catalog, pg_temp', 'lock_timeout=5s']::text[]
      )
  ) OR NOT pg_catalog.has_function_privilege(
    'service_role', v_submit, 'EXECUTE'
  ) OR NOT pg_catalog.has_function_privilege(
    'service_role', v_review, 'EXECUTE'
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.unnest(ARRAY['anon', 'authenticated']::name[]) AS grantee(role_name)
    CROSS JOIN pg_catalog.unnest(ARRAY[v_submit, v_review]) AS routine(function_oid)
    WHERE pg_catalog.has_function_privilege(
      grantee.role_name, routine.function_oid, 'EXECUTE'
    )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(function_row.proacl, pg_catalog.acldefault('f', function_row.proowner))
    ) AS acl_entry
    WHERE function_row.oid IN (v_submit, v_review)
      AND acl_entry.grantee <> function_row.proowner
      AND (
        acl_entry.grantee <> v_service_oid
        OR acl_entry.privilege_type <> 'EXECUTE'
        OR acl_entry.is_grantable
        OR acl_entry.grantor <> function_row.proowner
      )
  ) OR pg_catalog.obj_description(v_submit::oid, 'pg_proc') IS DISTINCT FROM
    'group-edit-application-operation-replay:submit:v1:' || (
      SELECT pg_catalog.md5(function_row.prosrc)
      FROM pg_catalog.pg_proc AS function_row WHERE function_row.oid = v_submit
    ) OR pg_catalog.obj_description(v_review::oid, 'pg_proc') IS DISTINCT FROM
    'group-edit-application-operation-replay:review:v1:' || (
      SELECT pg_catalog.md5(function_row.prosrc)
      FROM pg_catalog.pg_proc AS function_row WHERE function_row.oid = v_review
    )
  THEN
    RAISE EXCEPTION 'group-edit RPC catalog, ACL or source seal is not exact';
  END IF;

  SELECT pg_catalog.array_agg(attribute.attnum ORDER BY attribute.attnum)
  INTO v_profile_attnums
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = v_groups
    AND attribute.attname IN (
      'name', 'name_en', 'description', 'description_en', 'avatar_url',
      'role_names', 'rules_json', 'rules', 'is_premium_only'
    )
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = v_groups
      AND trigger_row.tgname = 'trg_groups_06_guard_profile_edit'
      AND trigger_row.tgfoid = v_guard
      AND trigger_row.tgenabled = 'O'
      AND trigger_row.tgtype = 19
      AND trigger_row.tgqual IS NULL
      AND trigger_row.tgnargs = 0
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgattr::smallint[] <@ v_profile_attnums
      AND trigger_row.tgattr::smallint[] @> v_profile_attnums
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_guard
      AND function_row.proowner = v_postgres_oid
      AND NOT function_row.prosecdef
      AND function_row.provolatile = 'v'
      AND function_row.prorettype = 'trigger'::pg_catalog.regtype
      AND function_row.prokind = 'f'
      AND NOT function_row.proleakproof
      AND function_row.proconfig = ARRAY['search_path=pg_catalog, pg_temp']::text[]
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.unnest(
      ARRAY['anon', 'authenticated', 'service_role']::name[]
    ) AS grantee(role_name)
    WHERE pg_catalog.has_function_privilege(
      grantee.role_name, v_guard, 'EXECUTE'
    )
  ) OR pg_catalog.obj_description(v_guard::oid, 'pg_proc') IS DISTINCT FROM
    'group-edit-application-operation-replay:profile-guard:v1:' || (
      SELECT pg_catalog.md5(function_row.prosrc)
      FROM pg_catalog.pg_proc AS function_row WHERE function_row.oid = v_guard
    )
  THEN
    RAISE EXCEPTION 'group profile direct-write guard is not exact';
  END IF;

  IF EXISTS (
    WITH RECURSIVE service_inheritors(member_oid) AS (
      SELECT membership.member
      FROM pg_catalog.pg_auth_members AS membership
      WHERE membership.roleid = v_service_oid
        AND membership.inherit_option
      UNION
      SELECT membership.member
      FROM pg_catalog.pg_auth_members AS membership
      JOIN service_inheritors AS inherited
        ON membership.roleid = inherited.member_oid
      WHERE membership.inherit_option
    )
    SELECT 1 FROM service_inheritors AS inherited
    WHERE inherited.member_oid <> v_postgres_oid
  ) OR EXISTS (
    WITH RECURSIVE service_inherits(role_oid) AS (
      SELECT membership.roleid
      FROM pg_catalog.pg_auth_members AS membership
      WHERE membership.member = v_service_oid
        AND membership.inherit_option
      UNION
      SELECT membership.roleid
      FROM pg_catalog.pg_auth_members AS membership
      JOIN service_inherits AS inherited
        ON membership.member = inherited.role_oid
      WHERE membership.inherit_option
    )
    SELECT 1 FROM service_inherits
  ) THEN
    RAISE EXCEPTION 'service_role inheritance changed during migration';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
