-- Make group mute/unmute one authorization, state and audit transaction.
-- The API route previously read roles separately, updated group_members, wrote
-- its audit best-effort and even created a direct-message conversation. This
-- RPC is the sole mutation boundary; notifications remain post-commit system
-- notifications and are deliberately outside this transaction.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('group-application-authority-migrations', 0)
);

DO $preflight$
DECLARE
  v_relation pg_catalog.regclass;
  v_relation_name text;
  v_postgres_oid oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'postgres'
  );
  v_service_oid oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'service_role'
  );
  v_auth_id_attnum smallint;
  v_profile_id_attnum smallint;
  v_groups_id_attnum smallint;
  v_member_group_attnum smallint;
  v_member_user_attnum smallint;
  v_muted_by_attnum smallint;
  v_audit_id_attnum smallint;
  v_audit_group_attnum smallint;
  v_audit_actor_attnum smallint;
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

  IF pg_catalog.to_regprocedure('auth.role()') IS NULL OR (
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
    'public.group_audit_log'
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
      SELECT 1
      FROM pg_catalog.pg_inherits AS inheritance
      WHERE inheritance.inhrelid = v_relation
        OR inheritance.inhparent = v_relation
    ) OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_rewrite AS rewrite_rule
      WHERE rewrite_rule.ev_class = v_relation
    ) THEN
      RAISE EXCEPTION 'atomic group-mute dependency relation is incompatible: %',
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
      'public.group_audit_log'::pg_catalog.regclass
    )
      AND relation.relowner <> v_postgres_oid
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = 'public.group_members'::pg_catalog.regclass
      AND relation.relrowsecurity
      AND NOT relation.relforcerowsecurity
  ) THEN
    RAISE EXCEPTION 'atomic group-mute public relation ownership/RLS is incompatible';
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
        ('public', 'groups', 'id', 'uuid'::pg_catalog.regtype, true),
        ('public', 'groups', 'name', 'text'::pg_catalog.regtype, true),
        ('public', 'groups', 'created_by', 'uuid'::pg_catalog.regtype, true),
        ('public', 'groups', 'member_count', 'integer'::pg_catalog.regtype, true),
        ('public', 'groups', 'dissolved_at', 'timestamptz'::pg_catalog.regtype, false),
        ('public', 'group_members', 'group_id', 'uuid'::pg_catalog.regtype, true),
        ('public', 'group_members', 'user_id', 'uuid'::pg_catalog.regtype, true),
        ('public', 'group_members', 'role', 'public.member_role'::pg_catalog.regtype, true),
        ('public', 'group_members', 'muted_until', 'timestamptz'::pg_catalog.regtype, false),
        ('public', 'group_members', 'mute_reason', 'text'::pg_catalog.regtype, false),
        ('public', 'group_members', 'muted_by', 'uuid'::pg_catalog.regtype, false),
        ('public', 'group_audit_log', 'id', 'uuid'::pg_catalog.regtype, true),
        ('public', 'group_audit_log', 'group_id', 'uuid'::pg_catalog.regtype, false),
        ('public', 'group_audit_log', 'actor_id', 'uuid'::pg_catalog.regtype, false),
        ('public', 'group_audit_log', 'action', 'text'::pg_catalog.regtype, true),
        ('public', 'group_audit_log', 'target_id', 'uuid'::pg_catalog.regtype, false),
        ('public', 'group_audit_log', 'details', 'jsonb'::pg_catalog.regtype, false),
        ('public', 'group_audit_log', 'created_at', 'timestamptz'::pg_catalog.regtype, false)
    ) AS required_column(
      schema_name,
      relation_name,
      column_name,
      type_oid,
      required_not_null
    )
    LEFT JOIN pg_catalog.pg_attribute AS attribute
      ON attribute.attrelid = pg_catalog.to_regclass(
        pg_catalog.format(
          '%I.%I',
          required_column.schema_name,
          required_column.relation_name
        )
      )
     AND attribute.attname = required_column.column_name
     AND attribute.attnum > 0
     AND NOT attribute.attisdropped
    WHERE attribute.attnum IS NULL
       OR attribute.atttypid <> required_column.type_oid
       OR attribute.attgenerated <> ''
       OR (
         required_column.required_not_null
         AND NOT attribute.attnotnull
       )
  ) THEN
    RAISE EXCEPTION 'atomic group-mute dependency columns are incompatible';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = 'public.group_members'::pg_catalog.regclass
      AND attribute.attname IN ('muted_until', 'mute_reason', 'muted_by')
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND attribute.attnotnull
  ) THEN
    RAISE EXCEPTION 'group mute state columns must remain nullable';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_enum AS enum_row
    WHERE enum_row.enumtypid = 'public.member_role'::pg_catalog.regtype
      AND enum_row.enumlabel = 'owner'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_enum AS enum_row
    WHERE enum_row.enumtypid = 'public.member_role'::pg_catalog.regtype
      AND enum_row.enumlabel = 'admin'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_enum AS enum_row
    WHERE enum_row.enumtypid = 'public.member_role'::pg_catalog.regtype
      AND enum_row.enumlabel = 'member'
  ) THEN
    RAISE EXCEPTION 'required group-mute role labels are missing';
  END IF;

  SELECT attribute.attnum
  INTO STRICT v_auth_id_attnum
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'auth.users'::pg_catalog.regclass
    AND attribute.attname = 'id'
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;
  SELECT attribute.attnum
  INTO STRICT v_profile_id_attnum
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.user_profiles'::pg_catalog.regclass
    AND attribute.attname = 'id'
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;
  SELECT attribute.attnum
  INTO STRICT v_groups_id_attnum
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.groups'::pg_catalog.regclass
    AND attribute.attname = 'id'
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;
  SELECT attribute.attnum
  INTO STRICT v_member_group_attnum
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.group_members'::pg_catalog.regclass
    AND attribute.attname = 'group_id'
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;
  SELECT attribute.attnum
  INTO STRICT v_member_user_attnum
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.group_members'::pg_catalog.regclass
    AND attribute.attname = 'user_id'
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;
  SELECT attribute.attnum
  INTO STRICT v_muted_by_attnum
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.group_members'::pg_catalog.regclass
    AND attribute.attname = 'muted_by'
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;
  SELECT attribute.attnum
  INTO STRICT v_audit_id_attnum
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.group_audit_log'::pg_catalog.regclass
    AND attribute.attname = 'id'
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;
  SELECT attribute.attnum
  INTO STRICT v_audit_group_attnum
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.group_audit_log'::pg_catalog.regclass
    AND attribute.attname = 'group_id'
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;
  SELECT attribute.attnum
  INTO STRICT v_audit_actor_attnum
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.group_audit_log'::pg_catalog.regclass
    AND attribute.attname = 'actor_id'
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'auth.users'::pg_catalog.regclass
      AND constraint_row.contype = 'p'
      AND constraint_row.conkey = ARRAY[v_auth_id_attnum]::smallint[]
      AND constraint_row.convalidated
      AND NOT constraint_row.condeferrable
      AND NOT constraint_row.condeferred
  ) <> 1 OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.user_profiles'::pg_catalog.regclass
      AND constraint_row.contype = 'p'
      AND constraint_row.conkey = ARRAY[v_profile_id_attnum]::smallint[]
      AND constraint_row.convalidated
      AND NOT constraint_row.condeferrable
      AND NOT constraint_row.condeferred
  ) <> 1 OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.groups'::pg_catalog.regclass
      AND constraint_row.contype = 'p'
      AND constraint_row.conkey = ARRAY[v_groups_id_attnum]::smallint[]
      AND constraint_row.convalidated
      AND NOT constraint_row.condeferrable
      AND NOT constraint_row.condeferred
  ) <> 1 OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.group_members'::pg_catalog.regclass
      AND constraint_row.contype = 'p'
      AND constraint_row.conkey = ARRAY[
        v_member_group_attnum,
        v_member_user_attnum
      ]::smallint[]
      AND constraint_row.convalidated
      AND NOT constraint_row.condeferrable
      AND NOT constraint_row.condeferred
  ) <> 1 OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.group_members'::pg_catalog.regclass
      AND constraint_row.contype = 'f'
      AND constraint_row.conkey = ARRAY[v_member_group_attnum]::smallint[]
      AND constraint_row.confrelid = 'public.groups'::pg_catalog.regclass
      AND constraint_row.confkey = ARRAY[v_groups_id_attnum]::smallint[]
      AND constraint_row.confdeltype = 'c'
      AND constraint_row.convalidated
      AND NOT constraint_row.condeferrable
      AND NOT constraint_row.condeferred
  ) <> 1 OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.group_members'::pg_catalog.regclass
      AND constraint_row.contype = 'f'
      AND constraint_row.conkey = ARRAY[v_member_user_attnum]::smallint[]
      AND constraint_row.confrelid = 'auth.users'::pg_catalog.regclass
      AND constraint_row.confkey = ARRAY[v_auth_id_attnum]::smallint[]
      AND constraint_row.confdeltype = 'c'
      AND constraint_row.convalidated
      AND NOT constraint_row.condeferrable
      AND NOT constraint_row.condeferred
  ) <> 1 OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.group_audit_log'::pg_catalog.regclass
      AND constraint_row.contype = 'p'
      AND constraint_row.conkey = ARRAY[v_audit_id_attnum]::smallint[]
      AND constraint_row.convalidated
      AND NOT constraint_row.condeferrable
      AND NOT constraint_row.condeferred
  ) <> 1 OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.group_members'::pg_catalog.regclass
      AND constraint_row.contype = 'f'
      AND constraint_row.conkey = ARRAY[v_muted_by_attnum]::smallint[]
      AND constraint_row.confrelid = 'auth.users'::pg_catalog.regclass
      AND constraint_row.confkey = ARRAY[v_auth_id_attnum]::smallint[]
      AND constraint_row.confdeltype = 'n'
      AND constraint_row.convalidated
      AND NOT constraint_row.condeferrable
      AND NOT constraint_row.condeferred
  ) <> 1 OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.group_audit_log'::pg_catalog.regclass
      AND constraint_row.contype = 'f'
      AND constraint_row.conkey = ARRAY[v_audit_actor_attnum]::smallint[]
      AND constraint_row.confrelid = 'auth.users'::pg_catalog.regclass
      AND constraint_row.confkey = ARRAY[v_auth_id_attnum]::smallint[]
      AND constraint_row.confdeltype = 'n'
      AND constraint_row.convalidated
      AND NOT constraint_row.condeferrable
      AND NOT constraint_row.condeferred
  ) <> 1 OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.group_audit_log'::pg_catalog.regclass
      AND constraint_row.contype = 'f'
      AND constraint_row.conkey = ARRAY[v_audit_group_attnum]::smallint[]
      AND constraint_row.confrelid = 'public.groups'::pg_catalog.regclass
      AND constraint_row.confkey = ARRAY[v_groups_id_attnum]::smallint[]
      AND constraint_row.confdeltype = 'c'
      AND constraint_row.convalidated
      AND NOT constraint_row.condeferrable
      AND NOT constraint_row.condeferred
  ) <> 1 THEN
    RAISE EXCEPTION 'atomic group-mute key/FK authority is incompatible';
  END IF;

  IF pg_catalog.to_regprocedure(
    'public.serialize_group_membership_edge()'
  ) IS NULL OR pg_catalog.to_regprocedure(
    'public.moderate_group_member_atomic(uuid,uuid,uuid,text,text)'
  ) IS NULL OR pg_catalog.to_regprocedure(
    'public.purge_deleted_account_group_edges(uuid)'
  ) IS NULL OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.group_members'::pg_catalog.regclass
      AND trigger_row.tgname = 'trg_group_members_05_serialize_edge'
      AND trigger_row.tgfoid =
        'public.serialize_group_membership_edge()'::pg_catalog.regprocedure
      AND trigger_row.tgenabled = 'O'
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgqual IS NULL
  ) THEN
    RAISE EXCEPTION 'atomic group membership/deletion layers must be applied first';
  END IF;

  -- An inherited service_role would inherit both table writes and every
  -- service-only RPC. Fail before any repair instead of trying to rewrite the
  -- cluster's role graph from an application migration.
  IF EXISTS (
    WITH RECURSIVE service_inheritors(member_oid) AS (
      SELECT membership.member
      FROM pg_catalog.pg_auth_members AS membership
      JOIN pg_catalog.pg_roles AS member_role
        ON member_role.oid = membership.member
      WHERE membership.roleid = v_service_oid
        AND member_role.rolinherit
      UNION
      SELECT membership.member
      FROM pg_catalog.pg_auth_members AS membership
      JOIN service_inheritors AS inherited
        ON membership.roleid = inherited.member_oid
      JOIN pg_catalog.pg_roles AS member_role
        ON member_role.oid = membership.member
      WHERE member_role.rolinherit
    )
    SELECT 1
    FROM service_inheritors AS inherited
    WHERE inherited.member_oid <> v_postgres_oid
  ) OR EXISTS (
    WITH RECURSIVE service_inherits(role_oid) AS (
      SELECT membership.roleid
      FROM pg_catalog.pg_auth_members AS membership
      JOIN pg_catalog.pg_roles AS service_role_row
        ON service_role_row.oid = membership.member
      WHERE membership.member = v_service_oid
        AND service_role_row.rolinherit
      UNION
      SELECT membership.roleid
      FROM pg_catalog.pg_auth_members AS membership
      JOIN service_inherits AS inherited
        ON membership.member = inherited.role_oid
      JOIN pg_catalog.pg_roles AS inherited_role
        ON inherited_role.oid = membership.member
      WHERE inherited_role.rolinherit
    )
    SELECT 1
    FROM service_inherits
  ) THEN
    RAISE EXCEPTION 'service_role has an unsafe effective inheritance edge';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.pronamespace = 'public'::pg_catalog.regnamespace
      AND function_row.proname = 'moderate_group_mute_atomic'
      AND pg_catalog.pg_get_function_identity_arguments(function_row.oid) <>
        'p_operation_id uuid, p_actor_id uuid, p_group_id uuid, p_target_id uuid, p_action text, p_muted_until timestamp with time zone, p_reason text'
  ) THEN
    RAISE EXCEPTION 'incompatible moderate_group_mute_atomic overload exists';
  END IF;

END
$preflight$;

-- Avoid CREATE TABLE IF NOT EXISTS on replay: PostgreSQL can retain its table
-- lock in the outer transaction before the all-or-nothing lock protocol. The
-- guarded branch executes DDL only for a genuinely fresh ledger.
DO $create_group_mute_operations$
BEGIN
  IF pg_catalog.to_regclass('public.group_mute_operations') IS NULL THEN
    CREATE TABLE public.group_mute_operations (
  operation_id uuid NOT NULL,
  sequence_id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  actor_id uuid NOT NULL,
  group_id uuid NOT NULL,
  target_id uuid NOT NULL,
  action text NOT NULL,
  muted_until timestamptz,
  reason text,
  initial_applied boolean NOT NULL,
  evidence_kind text NOT NULL,
  evidence_operation_id uuid,
  evidence_audit_id uuid NOT NULL,
  evidence_actor_id uuid NOT NULL,
  evidence_action text NOT NULL,
  evidence_details jsonb NOT NULL,
  audit_log_id uuid,
  previous_muted_until timestamptz,
  previous_reason text,
  previous_muted_by uuid,
  result_group_name text NOT NULL,
  result_muted_until timestamptz,
  result_reason text,
  result_muted_by uuid,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CONSTRAINT group_mute_operations_pkey PRIMARY KEY (operation_id),
  CONSTRAINT group_mute_operations_sequence_id_key UNIQUE (sequence_id),
  CONSTRAINT group_mute_operations_audit_log_id_key UNIQUE (audit_log_id),
  CONSTRAINT group_mute_operations_action_check
    CHECK (action IN ('mute', 'unmute')),
  CONSTRAINT group_mute_operations_evidence_action_check
    CHECK (evidence_action IN ('mute', 'unmute')),
  CONSTRAINT group_mute_operations_evidence_kind_check
    CHECK (evidence_kind IN ('legacy_v1', 'operation_v2')),
  CONSTRAINT group_mute_operations_evidence_details_check
    CHECK (pg_catalog.jsonb_typeof(evidence_details) = 'object'),
  CONSTRAINT group_mute_operations_reason_check
    CHECK (pg_catalog.char_length(COALESCE(reason, '')) <= 500),
  CONSTRAINT group_mute_operations_request_result_check
    CHECK (
      (
        action = 'mute'
        AND muted_until IS NOT NULL
        AND result_muted_until IS NOT DISTINCT FROM muted_until
        AND result_reason IS NOT DISTINCT FROM reason
        AND result_muted_by IS NOT DISTINCT FROM actor_id
      ) OR (
        action = 'unmute'
        AND muted_until IS NULL
        AND reason IS NULL
        AND result_muted_until IS NULL
        AND result_reason IS NULL
        AND result_muted_by IS NULL
      )
    ),
  CONSTRAINT group_mute_operations_evidence_check
    CHECK (
      (
        initial_applied
        AND evidence_kind = 'operation_v2'
        AND evidence_operation_id = operation_id
        AND audit_log_id IS NOT NULL
        AND audit_log_id = evidence_audit_id
        AND evidence_actor_id = actor_id
        AND evidence_action = action
      ) OR (
        NOT initial_applied
        AND audit_log_id IS NULL
        AND (
          (
            evidence_kind = 'operation_v2'
            AND evidence_operation_id IS NOT NULL
          ) OR (
            evidence_kind = 'legacy_v1'
            AND evidence_operation_id IS NULL
          )
        )
      )
    ),
  CONSTRAINT group_mute_operations_group_name_check
    CHECK (pg_catalog.char_length(result_group_name) > 0)
    );
  END IF;
END
$create_group_mute_operations$;

-- Acquire the complete dependency set atomically. Each inner BEGIN/EXCEPTION
-- is a subtransaction: a NOWAIT miss rolls back every table lock acquired by
-- that attempt before the short backoff. This prevents a migration holding an
-- Auth/audit child while waiting on groups (or the reverse), including raw
-- child-first writers that do not participate in application lock ordering.
-- The ledger is first and is also the runtime deployment barrier.
DO $lock_complete_dependency_set$
DECLARE
  v_deadline timestamptz := pg_catalog.clock_timestamp() + interval '30 seconds';
  v_complete boolean;
BEGIN
  LOOP
    v_complete := false;
    BEGIN
      LOCK TABLE public.group_mute_operations
        IN ACCESS EXCLUSIVE MODE NOWAIT;
      LOCK TABLE auth.users, public.user_profiles
        IN SHARE MODE NOWAIT;
      LOCK TABLE public.groups, public.group_members
        IN ACCESS EXCLUSIVE MODE NOWAIT;
      LOCK TABLE public.group_audit_log
        IN SHARE MODE NOWAIT;
      v_complete := true;
    EXCEPTION
      WHEN lock_not_available THEN
        -- Exiting this exception subtransaction releases partial-attempt locks.
        NULL;
    END;

    EXIT WHEN v_complete;
    IF pg_catalog.clock_timestamp() >= v_deadline THEN
      RAISE EXCEPTION USING
        ERRCODE = '55P03',
        MESSAGE = 'timed out acquiring the atomic group-mute migration lock set';
    END IF;
    PERFORM pg_catalog.pg_sleep(0.05);
  END LOOP;
END
$lock_complete_dependency_set$;

ALTER TABLE public.group_mute_operations OWNER TO postgres;
COMMENT ON TABLE public.group_mute_operations IS
  'atomic-group-mute-operation-ledger:v2';

CREATE INDEX IF NOT EXISTS group_mute_operations_target_sequence_idx
  ON public.group_mute_operations (group_id, target_id, sequence_id DESC);
CREATE INDEX IF NOT EXISTS group_mute_operations_latest_applied_idx
  ON public.group_mute_operations (group_id, target_id, sequence_id DESC)
  WHERE initial_applied;

DO $converge_table_authority$
DECLARE
  v_relation_name text;
  v_relation_oid oid;
  v_relation_owner oid;
  v_column_list text;
  v_grantee record;
  v_policy record;
BEGIN
  -- Converge the two established group tables back to the exact 111800 read/
  -- write boundary. groups deliberately loses direct service_role DELETE;
  -- deletion remains behind narrow security-definer review boundaries.
  FOREACH v_relation_name IN ARRAY ARRAY[
    'groups',
    'group_members'
  ]::text[]
  LOOP
    v_relation_oid := pg_catalog.to_regclass('public.' || v_relation_name);
    SELECT relation.relowner
    INTO STRICT v_relation_owner
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = v_relation_oid;

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
      pg_catalog.format('%I', attribute.attname),
      ', '
      ORDER BY attribute.attnum
    )
    INTO v_column_list
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = v_relation_oid
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped;

    FOR v_grantee IN
      SELECT DISTINCT acl_entry.grantee, role_row.rolname
      FROM pg_catalog.pg_attribute AS attribute
      CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl_entry
      LEFT JOIN pg_catalog.pg_roles AS role_row
        ON role_row.oid = acl_entry.grantee
      WHERE attribute.attrelid = v_relation_oid
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
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

    EXECUTE pg_catalog.format(
      'ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',
      v_relation_name
    );
    EXECUTE pg_catalog.format(
      'ALTER TABLE public.%I NO FORCE ROW LEVEL SECURITY',
      v_relation_name
    );
  END LOOP;

  GRANT SELECT ON TABLE public.groups TO anon, authenticated;
  GRANT SELECT, INSERT, UPDATE ON TABLE public.groups TO service_role;
  GRANT SELECT ON TABLE public.group_members TO anon, authenticated;
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.group_members TO service_role;

  CREATE POLICY browser_read ON public.groups
    AS PERMISSIVE FOR SELECT TO anon, authenticated USING (true);
  CREATE POLICY server_role_mutation ON public.groups
    AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
  CREATE POLICY browser_read ON public.group_members
    AS PERMISSIVE FOR SELECT TO anon, authenticated USING (true);
  CREATE POLICY server_role_mutation ON public.group_members
    AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);

  -- The operation ledger is owner-only, including under FORCE RLS. Neither
  -- service_role nor a browser/custom role receives direct table authority.
  FOREACH v_relation_name IN ARRAY ARRAY['group_mute_operations']::text[]
  LOOP
    v_relation_oid := pg_catalog.to_regclass('public.' || v_relation_name);
    SELECT relation.relowner
    INTO STRICT v_relation_owner
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = v_relation_oid;

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

    SELECT pg_catalog.string_agg(
      pg_catalog.format('%I', attribute.attname),
      ', '
      ORDER BY attribute.attnum
    )
    INTO v_column_list
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = v_relation_oid
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped;

    FOR v_grantee IN
      SELECT DISTINCT acl_entry.grantee, role_row.rolname
      FROM pg_catalog.pg_attribute AS attribute
      CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl_entry
      LEFT JOIN pg_catalog.pg_roles AS role_row
        ON role_row.oid = acl_entry.grantee
      WHERE attribute.attrelid = v_relation_oid
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
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

    EXECUTE pg_catalog.format(
      'ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',
      v_relation_name
    );
    EXECUTE pg_catalog.format(
      'ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',
      v_relation_name
    );
    EXECUTE pg_catalog.format(
      'CREATE POLICY ledger_owner_all ON public.%I '
        || 'AS PERMISSIVE FOR ALL TO postgres USING (true) WITH CHECK (true)',
      v_relation_name
    );
  END LOOP;
END
$converge_table_authority$;

CREATE OR REPLACE FUNCTION public.moderate_group_mute_atomic(
  p_operation_id uuid,
  p_actor_id uuid,
  p_group_id uuid,
  p_target_id uuid,
  p_action text,
  p_muted_until timestamptz,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_existing_operation public.group_mute_operations%ROWTYPE;
  v_existing_operation_found boolean := false;
  v_evidence_operation public.group_mute_operations%ROWTYPE;
  v_evidence_operation_found boolean := false;
  v_applied_evidence public.group_mute_operations%ROWTYPE;
  v_applied_evidence_found boolean := false;
  v_evidence_audit public.group_audit_log%ROWTYPE;
  v_evidence_audit_found boolean := false;
  v_evidence_kind text;
  v_evidence_operation_id uuid;
  v_evidence_actor_id uuid;
  v_evidence_action text;
  v_evidence_details jsonb;
  v_actor_auth_found boolean := false;
  v_target_auth_found boolean := false;
  v_actor_profile public.user_profiles%ROWTYPE;
  v_target_profile public.user_profiles%ROWTYPE;
  v_actor_profile_found boolean := false;
  v_target_profile_found boolean := false;
  v_group public.groups%ROWTYPE;
  v_group_found boolean := false;
  v_actor_role text;
  v_target_role text;
  v_actor_is_member boolean := false;
  v_target_is_member boolean := false;
  v_reason text := NULLIF(pg_catalog.btrim(COALESCE(p_reason, '')), '');
  v_now timestamptz;
  v_audit_id uuid;
  v_audit_details jsonb;
  v_affected integer := 0;
  v_first_edge text;
  v_second_edge text;
  v_member record;
  v_auth_id uuid;
  v_profile record;
  v_previous_muted_until timestamptz;
  v_previous_reason text;
  v_previous_muted_by uuid;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'service role required';
  END IF;

  IF p_operation_id IS NULL
     OR p_actor_id IS NULL
     OR p_group_id IS NULL
     OR p_target_id IS NULL
     OR p_action IS NULL
     OR p_action NOT IN ('mute', 'unmute')
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'operation, actor, group, target and a canonical mute action are required';
  END IF;

  IF p_action = 'mute' AND (
    p_muted_until IS NULL
    OR pg_catalog.char_length(COALESCE(v_reason, '')) > 500
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'mute timestamp/reason is invalid';
  END IF;
  IF p_action = 'unmute' AND (
    p_muted_until IS NOT NULL
    OR p_reason IS NOT NULL
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'unmute parameters must be null';
  END IF;

  -- Deployment barrier: migration replay holds ACCESS EXCLUSIVE on the ledger
  -- before touching any dependency. Runtime takes this weaker lock before all
  -- advisory/row locks, so neither side can form a groups -> audit DDL cycle.
  LOCK TABLE public.group_mute_operations IN ROW EXCLUSIVE MODE;

  -- After the deployment table barrier, the operation key is the first
  -- per-request lock. Its owner-only ledger is intentionally independent of
  -- Auth, groups and audit FKs, so retention or cascading deletion can never
  -- make a committed UUID reusable.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'group-mute-operation:' || p_operation_id::text,
      0
    )
  );

  SELECT operation_row.*
  INTO v_existing_operation
  FROM public.group_mute_operations AS operation_row
  WHERE operation_row.operation_id = p_operation_id
  FOR UPDATE;
  v_existing_operation_found := FOUND;

  IF v_existing_operation_found THEN
    IF v_existing_operation.actor_id IS DISTINCT FROM p_actor_id
       OR v_existing_operation.group_id IS DISTINCT FROM p_group_id
       OR v_existing_operation.target_id IS DISTINCT FROM p_target_id
       OR v_existing_operation.action IS DISTINCT FROM p_action
       OR v_existing_operation.muted_until IS DISTINCT FROM p_muted_until
       OR v_existing_operation.reason IS DISTINCT FROM v_reason
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '40001',
        MESSAGE = 'operation id payload collision';
    END IF;

    RETURN pg_catalog.jsonb_build_object(
      'success', true,
      'applied', false,
      'operation_id', p_operation_id,
      'action', v_existing_operation.action,
      'group_id', v_existing_operation.group_id,
      'target_id', v_existing_operation.target_id,
      'group_name', v_existing_operation.result_group_name,
      'muted_until', v_existing_operation.result_muted_until,
      'mute_reason', v_existing_operation.result_reason,
      'muted_by', v_existing_operation.result_muted_by,
      'audit_log_id', NULL
    );
  END IF;

  IF p_actor_id = p_target_id THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'SELF_FORBIDDEN'
    );
  END IF;

  -- Auth parents are always first. A direct Auth deletion holds this row lock
  -- before cascading to group_members, whose serializer takes the membership
  -- advisory. Taking the advisory first here would create the cycle
  -- mute(advisory -> Auth) versus delete(Auth -> advisory).
  FOR v_auth_id IN
    SELECT auth_user.id
    FROM auth.users AS auth_user
    WHERE auth_user.id IN (p_actor_id, p_target_id)
    ORDER BY auth_user.id
    FOR SHARE
  LOOP
    IF v_auth_id = p_actor_id THEN
      v_actor_auth_found := true;
    END IF;
    IF v_auth_id = p_target_id THEN
      v_target_auth_found := true;
    END IF;
  END LOOP;

  IF NOT v_actor_auth_found THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'ACTOR_UNAVAILABLE'
    );
  END IF;
  IF NOT v_target_auth_found THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'TARGET_UNAVAILABLE'
    );
  END IF;

  -- Once both Auth parents are stable, serialize both actor/target membership
  -- edges in UUID order. Kick, leave, role and account-purge paths use these
  -- exact keys; any later FK KEY SHARE they take is compatible with our SHARE.
  v_first_edge := 'group-membership:' || p_group_id::text || ':'
    || LEAST(p_actor_id::text, p_target_id::text);
  v_second_edge := 'group-membership:' || p_group_id::text || ':'
    || GREATEST(p_actor_id::text, p_target_id::text);

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_first_edge, 0)
  );
  IF v_second_edge <> v_first_edge THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(v_second_edge, 0)
    );
  END IF;

  FOR v_profile IN
    SELECT profile.*
    FROM public.user_profiles AS profile
    WHERE profile.id IN (p_actor_id, p_target_id)
    ORDER BY profile.id
    FOR UPDATE
  LOOP
    IF v_profile.id = p_actor_id THEN
      v_actor_profile := v_profile;
      v_actor_profile_found := true;
    END IF;
    IF v_profile.id = p_target_id THEN
      v_target_profile := v_profile;
      v_target_profile_found := true;
    END IF;
  END LOOP;

  v_now := pg_catalog.clock_timestamp();
  IF NOT v_actor_profile_found
     OR v_actor_profile.deleted_at IS NOT NULL
     OR v_actor_profile.banned_at IS NOT NULL
     OR (
       v_actor_profile.is_banned IS TRUE
       AND (
         v_actor_profile.ban_expires_at IS NULL
         OR v_actor_profile.ban_expires_at > v_now
       )
     )
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'ACTOR_UNAVAILABLE'
    );
  END IF;
  IF NOT v_target_profile_found
     OR v_target_profile.deleted_at IS NOT NULL
     OR v_target_profile.banned_at IS NOT NULL
     OR (
       v_target_profile.is_banned IS TRUE
       AND (
         v_target_profile.ban_expires_at IS NULL
         OR v_target_profile.ban_expires_at > v_now
       )
     )
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'TARGET_UNAVAILABLE'
    );
  END IF;

  SELECT target_group.*
  INTO v_group
  FROM public.groups AS target_group
  WHERE target_group.id = p_group_id
  FOR UPDATE;
  v_group_found := FOUND;

  IF NOT v_group_found THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'GROUP_NOT_FOUND'
    );
  END IF;
  IF v_group.dissolved_at IS NOT NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'GROUP_DISSOLVED'
    );
  END IF;
  IF v_group.name IS NULL OR pg_catalog.char_length(v_group.name) = 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'group name acknowledgement is invalid';
  END IF;

  -- Actor and target membership rows are locked together in UUID order. Role
  -- changes, kicks, leaves and membership deletion are therefore re-read after
  -- their transaction commits instead of being authorized from stale reads.
  FOR v_member IN
    SELECT
      member.user_id,
      member.role::text AS role,
      member.muted_until,
      member.mute_reason,
      member.muted_by
    FROM public.group_members AS member
    WHERE member.group_id = p_group_id
      AND member.user_id IN (p_actor_id, p_target_id)
    ORDER BY member.user_id
    FOR UPDATE
  LOOP
    IF v_member.user_id = p_actor_id THEN
      v_actor_role := v_member.role;
      v_actor_is_member := true;
    END IF;
    IF v_member.user_id = p_target_id THEN
      v_target_role := v_member.role;
      v_target_is_member := true;
      v_previous_muted_until := v_member.muted_until;
      v_previous_reason := v_member.mute_reason;
      v_previous_muted_by := v_member.muted_by;
    END IF;
  END LOOP;

  IF NOT v_actor_is_member OR v_actor_role NOT IN ('owner', 'admin') THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'ACTOR_NOT_MANAGER'
    );
  END IF;
  IF NOT v_target_is_member THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'TARGET_NOT_MEMBER'
    );
  END IF;
  IF p_target_id = v_group.created_by OR v_target_role = 'owner' THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'OWNER_FORBIDDEN'
    );
  END IF;
  IF v_actor_role = 'admin' AND v_target_role <> 'member' THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'HIERARCHY_FORBIDDEN'
    );
  END IF;

  v_now := pg_catalog.clock_timestamp();
  IF p_action = 'mute' AND (
    p_muted_until <= v_now
    OR p_muted_until > v_now + INTERVAL '101 years'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'mute timestamp must be future and at most 101 years';
  END IF;

  -- A different operation UUID may acknowledge an already-equal state only
  -- when the latest immutable applied operation and the latest raw audit row
  -- prove that exact state transition. State alone, or a forgeable audit row
  -- alone, is never accepted as evidence.
  IF (
    p_action = 'mute'
    AND v_previous_muted_until IS NOT DISTINCT FROM p_muted_until
    AND v_previous_reason IS NOT DISTINCT FROM v_reason
    AND v_previous_muted_by IS NOT DISTINCT FROM p_actor_id
  ) OR (
    p_action = 'unmute'
    AND v_previous_muted_until IS NULL
    AND v_previous_reason IS NULL
    AND v_previous_muted_by IS NULL
  ) THEN
    SELECT operation_row.*
    INTO v_evidence_operation
    FROM public.group_mute_operations AS operation_row
    WHERE operation_row.group_id = p_group_id
      AND operation_row.target_id = p_target_id
    ORDER BY operation_row.sequence_id DESC
    LIMIT 1
    FOR UPDATE;
    v_evidence_operation_found := FOUND;

    SELECT audit_row.*
    INTO v_evidence_audit
    FROM public.group_audit_log AS audit_row
    WHERE audit_row.group_id IS NOT DISTINCT FROM p_group_id
      AND audit_row.target_id IS NOT DISTINCT FROM p_target_id
      AND audit_row.action IN ('mute', 'unmute')
    ORDER BY audit_row.created_at DESC NULLS FIRST, audit_row.id DESC
    LIMIT 1
    FOR UPDATE;
    v_evidence_audit_found := FOUND;

    IF v_evidence_operation_found THEN
      v_evidence_kind := v_evidence_operation.evidence_kind;
      v_evidence_operation_id :=
        v_evidence_operation.evidence_operation_id;
      v_evidence_actor_id := v_evidence_operation.evidence_actor_id;
      v_evidence_action := v_evidence_operation.evidence_action;
      v_evidence_details := v_evidence_operation.evidence_details;

      IF v_evidence_kind = 'operation_v2' THEN
        SELECT operation_row.*
        INTO v_applied_evidence
        FROM public.group_mute_operations AS operation_row
        WHERE operation_row.group_id = p_group_id
          AND operation_row.target_id = p_target_id
          AND operation_row.initial_applied
        ORDER BY operation_row.sequence_id DESC
        LIMIT 1
        FOR UPDATE;
        v_applied_evidence_found := FOUND;

        IF NOT v_applied_evidence_found
           OR v_applied_evidence.operation_id
             IS DISTINCT FROM v_evidence_operation_id
           OR v_applied_evidence.evidence_audit_id
             IS DISTINCT FROM v_evidence_operation.evidence_audit_id
           OR v_applied_evidence.evidence_actor_id
             IS DISTINCT FROM v_evidence_actor_id
           OR v_applied_evidence.evidence_action
             IS DISTINCT FROM v_evidence_action
           OR v_applied_evidence.evidence_details
             IS DISTINCT FROM v_evidence_details
        THEN
          RAISE EXCEPTION USING
            ERRCODE = '40001',
            MESSAGE = 'current mute state lacks latest applied operation evidence; retry';
        END IF;
      ELSIF v_evidence_kind <> 'legacy_v1'
            OR v_evidence_operation_id IS NOT NULL
      THEN
        RAISE EXCEPTION USING
          ERRCODE = '40001',
          MESSAGE = 'current mute state has invalid sealed legacy evidence; retry';
      END IF;

      IF v_evidence_operation.action IS DISTINCT FROM p_action
         OR v_evidence_operation.result_muted_until
           IS DISTINCT FROM v_previous_muted_until
         OR v_evidence_operation.result_reason
           IS DISTINCT FROM v_previous_reason
         OR v_evidence_operation.result_muted_by
           IS DISTINCT FROM v_previous_muted_by
      THEN
        RAISE EXCEPTION USING
          ERRCODE = '40001',
          MESSAGE = 'current mute state diverged from the operation ledger; retry';
      END IF;
    ELSE
      -- A pre-migration state has no owner-only ledger. It may cross the
      -- boundary exactly once, using the old canonical audit shape; the new
      -- operation seals that raw evidence so later calls never fall back.
      IF NOT v_evidence_audit_found
         OR v_evidence_audit.created_at IS NULL
         OR v_evidence_audit.group_id IS DISTINCT FROM p_group_id
         OR v_evidence_audit.actor_id IS DISTINCT FROM p_actor_id
         OR v_evidence_audit.action IS DISTINCT FROM p_action
         OR v_evidence_audit.target_id IS DISTINCT FROM p_target_id
      THEN
        RAISE EXCEPTION USING
          ERRCODE = '40001',
          MESSAGE = 'legacy mute state lacks canonical audit evidence; retry';
      END IF;

      IF p_action = 'mute' THEN
        BEGIN
          IF pg_catalog.jsonb_typeof(v_evidence_audit.details) <> 'object'
             OR NOT v_evidence_audit.details ? 'duration'
             OR NOT v_evidence_audit.details ? 'reason'
             OR (
               SELECT pg_catalog.count(*)
               FROM pg_catalog.jsonb_object_keys(
                 v_evidence_audit.details
               ) AS detail_key
             ) <> 2
             OR pg_catalog.jsonb_typeof(
               v_evidence_audit.details -> 'duration'
             ) <> 'string'
             OR v_evidence_audit.details - 'duration'
               IS DISTINCT FROM pg_catalog.jsonb_build_object(
                 'reason', v_reason
               )
          THEN
            RAISE EXCEPTION USING
              ERRCODE = '40001',
              MESSAGE = 'legacy mute audit details are not canonical; retry';
          END IF;

          IF (v_evidence_audit.details ->> 'duration')::timestamptz
               IS DISTINCT FROM p_muted_until
          THEN
            RAISE EXCEPTION USING
              ERRCODE = '40001',
              MESSAGE = 'legacy mute audit details are not canonical; retry';
          END IF;
        EXCEPTION
          WHEN SQLSTATE '40001' THEN
            RAISE;
          WHEN OTHERS THEN
            RAISE EXCEPTION USING
              ERRCODE = '40001',
              MESSAGE = 'legacy mute audit details are not canonical; retry';
        END;
      ELSIF v_evidence_audit.details IS DISTINCT FROM '{}'::jsonb THEN
        RAISE EXCEPTION USING
          ERRCODE = '40001',
          MESSAGE = 'legacy unmute audit details are not canonical; retry';
      END IF;

      v_evidence_kind := 'legacy_v1';
      v_evidence_operation_id := NULL;
      v_evidence_actor_id := v_evidence_audit.actor_id;
      v_evidence_action := v_evidence_audit.action;
      v_evidence_details := v_evidence_audit.details;
    END IF;

    IF NOT v_evidence_audit_found
       OR v_evidence_audit.id
         IS DISTINCT FROM COALESCE(
           v_evidence_operation.evidence_audit_id,
           v_evidence_audit.id
         )
       OR v_evidence_audit.group_id IS DISTINCT FROM p_group_id
       OR v_evidence_audit.actor_id IS DISTINCT FROM v_evidence_actor_id
       OR v_evidence_audit.action IS DISTINCT FROM v_evidence_action
       OR v_evidence_audit.target_id IS DISTINCT FROM p_target_id
       OR v_evidence_audit.details IS DISTINCT FROM v_evidence_details
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '40001',
        MESSAGE = 'current mute state lacks exact audit evidence; retry';
    END IF;

    INSERT INTO public.group_mute_operations (
      operation_id,
      actor_id,
      group_id,
      target_id,
      action,
      muted_until,
      reason,
      initial_applied,
      evidence_kind,
      evidence_operation_id,
      evidence_audit_id,
      evidence_actor_id,
      evidence_action,
      evidence_details,
      audit_log_id,
      previous_muted_until,
      previous_reason,
      previous_muted_by,
      result_group_name,
      result_muted_until,
      result_reason,
      result_muted_by
    ) VALUES (
      p_operation_id,
      p_actor_id,
      p_group_id,
      p_target_id,
      p_action,
      p_muted_until,
      v_reason,
      false,
      v_evidence_kind,
      v_evidence_operation_id,
      v_evidence_audit.id,
      v_evidence_actor_id,
      v_evidence_action,
      v_evidence_details,
      NULL,
      v_previous_muted_until,
      v_previous_reason,
      v_previous_muted_by,
      v_group.name,
      v_previous_muted_until,
      v_previous_reason,
      v_previous_muted_by
    );
    GET DIAGNOSTICS v_affected = ROW_COUNT;
    IF v_affected <> 1 THEN
      RAISE EXCEPTION USING
        ERRCODE = '55000',
        MESSAGE = 'no-op operation acknowledgement is incomplete';
    END IF;

    RETURN pg_catalog.jsonb_build_object(
      'success', true,
      'applied', false,
      'operation_id', p_operation_id,
      'action', p_action,
      'group_id', p_group_id,
      'target_id', p_target_id,
      'group_name', v_group.name,
      'muted_until', v_previous_muted_until,
      'mute_reason', v_previous_reason,
      'muted_by', v_previous_muted_by,
      'audit_log_id', NULL
    );
  END IF;

  v_audit_id := pg_catalog.gen_random_uuid();
  IF p_action = 'mute' THEN
    UPDATE public.group_members AS member
    SET muted_until = p_muted_until,
        mute_reason = v_reason,
        muted_by = p_actor_id
    WHERE member.group_id = p_group_id
      AND member.user_id = p_target_id;
  ELSE
    UPDATE public.group_members AS member
    SET muted_until = NULL,
        mute_reason = NULL,
        muted_by = NULL
    WHERE member.group_id = p_group_id
      AND member.user_id = p_target_id;
  END IF;
  GET DIAGNOSTICS v_affected = ROW_COUNT;
  IF v_affected <> 1 THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'target membership changed while applying mute operation; retry';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.group_members AS member
    WHERE member.group_id = p_group_id
      AND member.user_id = p_target_id
      AND member.muted_until IS NOT DISTINCT FROM (
        CASE WHEN p_action = 'mute' THEN p_muted_until ELSE NULL END
      )
      AND member.mute_reason IS NOT DISTINCT FROM (
        CASE WHEN p_action = 'mute' THEN v_reason ELSE NULL END
      )
      AND member.muted_by IS NOT DISTINCT FROM (
        CASE WHEN p_action = 'mute' THEN p_actor_id ELSE NULL END
      )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'mute state acknowledgement is incomplete';
  END IF;

  v_audit_details := pg_catalog.jsonb_build_object(
    'schema', 'group-mute:v2',
    'operation_id', p_operation_id,
    'previous', pg_catalog.jsonb_build_object(
      'muted_until', v_previous_muted_until,
      'mute_reason', v_previous_reason,
      'muted_by', v_previous_muted_by
    ),
    'result', pg_catalog.jsonb_build_object(
      'muted_until', CASE WHEN p_action = 'mute' THEN p_muted_until ELSE NULL END,
      'mute_reason', CASE WHEN p_action = 'mute' THEN v_reason ELSE NULL END,
      'muted_by', CASE WHEN p_action = 'mute' THEN p_actor_id ELSE NULL END
    )
  );

  INSERT INTO public.group_audit_log (
    id,
    group_id,
    actor_id,
    action,
    target_id,
    details,
    created_at
  ) VALUES (
    v_audit_id,
    p_group_id,
    p_actor_id,
    p_action,
    p_target_id,
    v_audit_details,
    pg_catalog.clock_timestamp()
  );
  GET DIAGNOSTICS v_affected = ROW_COUNT;
  IF v_affected <> 1 OR NOT EXISTS (
    SELECT 1
    FROM public.group_audit_log AS audit_row
    WHERE audit_row.id = v_audit_id
      AND audit_row.group_id IS NOT DISTINCT FROM p_group_id
      AND audit_row.actor_id IS NOT DISTINCT FROM p_actor_id
      AND audit_row.action IS NOT DISTINCT FROM p_action
      AND audit_row.target_id IS NOT DISTINCT FROM p_target_id
      AND audit_row.details IS NOT DISTINCT FROM v_audit_details
      AND audit_row.created_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'mute audit acknowledgement is incomplete';
  END IF;

  INSERT INTO public.group_mute_operations (
    operation_id,
    actor_id,
    group_id,
    target_id,
    action,
    muted_until,
    reason,
    initial_applied,
    evidence_kind,
    evidence_operation_id,
    evidence_audit_id,
    evidence_actor_id,
    evidence_action,
    evidence_details,
    audit_log_id,
    previous_muted_until,
    previous_reason,
    previous_muted_by,
    result_group_name,
    result_muted_until,
    result_reason,
    result_muted_by
  ) VALUES (
    p_operation_id,
    p_actor_id,
    p_group_id,
    p_target_id,
    p_action,
    p_muted_until,
    v_reason,
    true,
    'operation_v2',
    p_operation_id,
    v_audit_id,
    p_actor_id,
    p_action,
    v_audit_details,
    v_audit_id,
    v_previous_muted_until,
    v_previous_reason,
    v_previous_muted_by,
    v_group.name,
    CASE WHEN p_action = 'mute' THEN p_muted_until ELSE NULL END,
    CASE WHEN p_action = 'mute' THEN v_reason ELSE NULL END,
    CASE WHEN p_action = 'mute' THEN p_actor_id ELSE NULL END
  );
  GET DIAGNOSTICS v_affected = ROW_COUNT;
  IF v_affected <> 1 THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'mute operation acknowledgement is incomplete';
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'success', true,
    'applied', true,
    'operation_id', p_operation_id,
    'action', p_action,
    'group_id', p_group_id,
    'target_id', p_target_id,
    'group_name', v_group.name,
    'muted_until', CASE WHEN p_action = 'mute' THEN p_muted_until ELSE NULL END,
    'mute_reason', CASE WHEN p_action = 'mute' THEN v_reason ELSE NULL END,
    'muted_by', CASE WHEN p_action = 'mute' THEN p_actor_id ELSE NULL END,
    'audit_log_id', v_audit_id
  );
END
$function$;

ALTER FUNCTION public.moderate_group_mute_atomic(
  uuid,
  uuid,
  uuid,
  uuid,
  text,
  timestamptz,
  text
) OWNER TO postgres;

DO $converge_acl_and_attest$
DECLARE
  v_function pg_catalog.regprocedure;
  v_owner oid;
  v_source text;
  v_comment_prefix text;
  v_grantee record;
BEGIN
  FOR v_function IN
    SELECT function_oid
    FROM pg_catalog.unnest(ARRAY[
      'public.moderate_group_mute_atomic(uuid,uuid,uuid,uuid,text,timestamptz,text)'::pg_catalog.regprocedure
    ]) AS expected(function_oid)
  LOOP
    SELECT function_row.proowner, function_row.prosrc
    INTO STRICT v_owner, v_source
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_function;

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
        AND acl_entry.grantee <> v_owner
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

    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON FUNCTION %s '
        || 'FROM PUBLIC, anon, authenticated, service_role',
      v_function
    );
    EXECUTE pg_catalog.format(
      'GRANT EXECUTE ON FUNCTION %s TO service_role',
      v_function
    );

    v_comment_prefix := 'atomic-group-mute:v2:';
    EXECUTE pg_catalog.format(
      'COMMENT ON FUNCTION %s IS %L',
      v_function,
      v_comment_prefix || pg_catalog.md5(v_source)
    );
  END LOOP;
END
$converge_acl_and_attest$;

DO $postflight$
DECLARE
  v_function pg_catalog.regprocedure :=
    'public.moderate_group_mute_atomic(uuid,uuid,uuid,uuid,text,timestamptz,text)'::pg_catalog.regprocedure;
  v_postgres_oid oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'postgres'
  );
  v_service_oid oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'service_role'
  );
  v_source text;
BEGIN
  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.pronamespace = 'public'::pg_catalog.regnamespace
      AND function_row.proname = 'moderate_group_mute_atomic'
  ) <> 1 OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_language AS language_row
      ON language_row.oid = function_row.prolang
    WHERE function_row.oid = v_function
      AND function_row.prokind = 'f'
      AND function_row.prorettype = 'jsonb'::pg_catalog.regtype
      AND NOT function_row.proretset
      AND function_row.pronargs = 7
      AND function_row.pronargdefaults = 0
      AND function_row.proargnames = ARRAY[
        'p_operation_id',
        'p_actor_id',
        'p_group_id',
        'p_target_id',
        'p_action',
        'p_muted_until',
        'p_reason'
      ]::text[]
      AND function_row.prosecdef
      AND function_row.provolatile = 'v'
      AND function_row.proparallel = 'u'
      AND NOT function_row.proleakproof
      AND function_row.proowner = v_postgres_oid
      AND language_row.lanname = 'plpgsql'
      AND function_row.proconfig = ARRAY[
        'search_path=pg_catalog, pg_temp',
        'lock_timeout=5s'
      ]::text[]
      AND pg_catalog.obj_description(function_row.oid, 'pg_proc') =
        'atomic-group-mute:v2:' || pg_catalog.md5(function_row.prosrc)
  ) THEN
    RAISE EXCEPTION 'atomic group-mute function metadata/digest drifted';
  END IF;

  IF NOT pg_catalog.has_function_privilege(
    'service_role',
    v_function,
    'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'anon',
    v_function,
    'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'authenticated',
    v_function,
    'EXECUTE'
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
      AND acl_entry.grantee <> function_row.proowner
      AND (
        acl_entry.grantee <> v_service_oid
        OR acl_entry.privilege_type <> 'EXECUTE'
        OR acl_entry.is_grantable
      )
  ) THEN
    RAISE EXCEPTION 'atomic group-mute EXECUTE boundary drifted';
  END IF;

  SELECT function_row.prosrc
  INTO STRICT v_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_function;

  IF pg_catalog.strpos(v_source, 'group-membership:') = 0
     OR pg_catalog.strpos(v_source, 'FROM auth.users AS auth_user') = 0
     OR pg_catalog.strpos(v_source, 'FROM public.user_profiles AS profile') = 0
     OR pg_catalog.strpos(v_source, 'FROM public.groups AS target_group') = 0
     OR pg_catalog.strpos(v_source, 'FROM public.group_members AS member') = 0
     OR pg_catalog.strpos(v_source, 'INSERT INTO public.group_audit_log') = 0
     OR pg_catalog.strpos(v_source, 'FROM auth.users AS auth_user') >
       pg_catalog.strpos(v_source, 'group-membership:')
     OR pg_catalog.strpos(v_source, 'group-membership:') >
       pg_catalog.strpos(v_source, 'FROM public.user_profiles AS profile')
     OR pg_catalog.strpos(v_source, 'FROM public.user_profiles AS profile') >
       pg_catalog.strpos(v_source, 'FROM public.groups AS target_group')
     OR pg_catalog.strpos(v_source, 'FROM public.groups AS target_group') >
       pg_catalog.strpos(v_source, 'FROM public.group_members AS member')
     OR pg_catalog.strpos(v_source, 'UPDATE public.group_members AS member') >
       pg_catalog.strpos(v_source, 'INSERT INTO public.group_audit_log')
  THEN
    RAISE EXCEPTION 'atomic group-mute lock/mutation behavior drifted';
  END IF;
END
$postflight$;

DO $exact_function_boundary$
DECLARE
  v_mute pg_catalog.regprocedure :=
    'public.moderate_group_mute_atomic(uuid,uuid,uuid,uuid,text,timestamptz,text)'::pg_catalog.regprocedure;
  v_function pg_catalog.regprocedure;
  v_postgres_oid oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'postgres'
  );
  v_service_oid oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'service_role'
  );
  v_source text;
BEGIN
  FOR v_function IN
    SELECT function_oid
    FROM pg_catalog.unnest(ARRAY[v_mute])
      AS expected(function_oid)
  LOOP
    IF NOT pg_catalog.has_function_privilege(
      'service_role',
      v_function,
      'EXECUTE'
    ) OR pg_catalog.has_function_privilege(
      'anon',
      v_function,
      'EXECUTE'
    ) OR pg_catalog.has_function_privilege(
      'authenticated',
      v_function,
      'EXECUTE'
    ) OR (
      SELECT pg_catalog.count(*)
      FROM pg_catalog.pg_proc AS function_row
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          function_row.proacl,
          pg_catalog.acldefault('f', function_row.proowner)
        )
      ) AS acl_entry
      WHERE function_row.oid = v_function
        AND acl_entry.grantee <> function_row.proowner
    ) <> 1 OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS function_row
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          function_row.proacl,
          pg_catalog.acldefault('f', function_row.proowner)
        )
      ) AS acl_entry
      WHERE function_row.oid = v_function
        AND acl_entry.grantee <> function_row.proowner
        AND (
          acl_entry.grantee <> v_service_oid
          OR acl_entry.grantor <> v_postgres_oid
          OR acl_entry.privilege_type <> 'EXECUTE'
          OR acl_entry.is_grantable
        )
    ) THEN
      RAISE EXCEPTION 'atomic group function EXECUTE inventory drifted';
    END IF;
  END LOOP;

  SELECT function_row.prosrc
  INTO STRICT v_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_mute;

  IF pg_catalog.strpos(
       v_source,
       'LOCK TABLE public.group_mute_operations IN ROW EXCLUSIVE MODE'
     ) = 0
     OR pg_catalog.strpos(v_source, 'group-mute-operation:') = 0
     OR pg_catalog.strpos(
       v_source,
       'FROM public.group_mute_operations AS operation_row'
     ) = 0
     OR pg_catalog.strpos(v_source, 'FROM auth.users AS auth_user') = 0
     OR pg_catalog.strpos(v_source, 'group-membership:') = 0
     OR pg_catalog.strpos(v_source, 'FROM public.user_profiles AS profile') = 0
     OR pg_catalog.strpos(v_source, 'FROM public.groups AS target_group') = 0
     OR pg_catalog.strpos(v_source, 'FROM public.group_members AS member') = 0
     OR pg_catalog.strpos(
       v_source,
       'LOCK TABLE public.group_mute_operations IN ROW EXCLUSIVE MODE'
     ) > pg_catalog.strpos(v_source, 'group-mute-operation:')
     OR pg_catalog.strpos(v_source, 'group-mute-operation:') >
       pg_catalog.strpos(
         v_source,
         'FROM public.group_mute_operations AS operation_row'
       )
     OR pg_catalog.strpos(
       v_source,
       'FROM public.group_mute_operations AS operation_row'
     ) > pg_catalog.strpos(v_source, 'FROM auth.users AS auth_user')
     OR pg_catalog.strpos(v_source, 'FROM auth.users AS auth_user') >
       pg_catalog.strpos(v_source, 'group-membership:')
     OR pg_catalog.strpos(v_source, 'group-membership:') >
       pg_catalog.strpos(v_source, 'FROM public.user_profiles AS profile')
     OR pg_catalog.strpos(v_source, 'FROM public.user_profiles AS profile') >
       pg_catalog.strpos(v_source, 'FROM public.groups AS target_group')
     OR pg_catalog.strpos(v_source, 'FROM public.groups AS target_group') >
       pg_catalog.strpos(v_source, 'FROM public.group_members AS member')
     OR pg_catalog.strpos(v_source, 'UPDATE public.group_members AS member') >
       pg_catalog.strpos(v_source, 'INSERT INTO public.group_audit_log')
  THEN
    RAISE EXCEPTION 'atomic group-mute lock/mutation ordering drifted';
  END IF;

END
$exact_function_boundary$;

DO $exact_table_authority$
DECLARE
  v_postgres_oid oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'postgres'
  );
  v_anon_oid oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'anon'
  );
  v_authenticated_oid oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'authenticated'
  );
  v_service_oid oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'service_role'
  );
BEGIN
  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('public.groups'::pg_catalog.regclass, false),
        ('public.group_members'::pg_catalog.regclass, false),
        ('public.group_mute_operations'::pg_catalog.regclass, true)
    ) AS expected(relation_oid, force_rls)
    JOIN pg_catalog.pg_class AS relation
      ON relation.oid = expected.relation_oid
    WHERE relation.relkind <> 'r'
       OR relation.relpersistence <> 'p'
       OR relation.relispartition
       OR relation.relowner <> v_postgres_oid
       OR NOT relation.relrowsecurity
       OR relation.relforcerowsecurity IS DISTINCT FROM expected.force_rls
  ) THEN
    RAISE EXCEPTION 'atomic group table ownership/RLS flags drifted';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_class AS relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        relation.relacl,
        pg_catalog.acldefault('r', relation.relowner)
      )
    ) AS acl_entry
    WHERE relation.oid = 'public.groups'::pg_catalog.regclass
      AND acl_entry.grantee <> relation.relowner
  ) <> 5 OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_class AS relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        relation.relacl,
        pg_catalog.acldefault('r', relation.relowner)
      )
    ) AS acl_entry
    WHERE relation.oid = 'public.group_members'::pg_catalog.regclass
      AND acl_entry.grantee <> relation.relowner
  ) <> 6 OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        relation.relacl,
        pg_catalog.acldefault('r', relation.relowner)
      )
    ) AS acl_entry
    WHERE relation.oid IN (
      'public.groups'::pg_catalog.regclass,
      'public.group_members'::pg_catalog.regclass
    )
      AND acl_entry.grantee <> relation.relowner
      AND (
        acl_entry.grantor <> v_postgres_oid
        OR acl_entry.is_grantable
        OR NOT (
          (
            acl_entry.grantee IN (v_anon_oid, v_authenticated_oid)
            AND acl_entry.privilege_type = 'SELECT'
          ) OR (
            acl_entry.grantee = v_service_oid
            AND (
              (
                relation.oid = 'public.groups'::pg_catalog.regclass
                AND acl_entry.privilege_type IN ('SELECT', 'INSERT', 'UPDATE')
              ) OR (
                relation.oid = 'public.group_members'::pg_catalog.regclass
                AND acl_entry.privilege_type IN (
                  'SELECT',
                  'INSERT',
                  'UPDATE',
                  'DELETE'
                )
              )
            )
          )
        )
      )
  ) THEN
    RAISE EXCEPTION 'groups/group_members table ACL inventory drifted';
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
    WHERE relation.oid = 'public.group_mute_operations'::pg_catalog.regclass
      AND acl_entry.grantee <> relation.relowner
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl_entry
    WHERE attribute.attrelid IN (
      'public.groups'::pg_catalog.regclass,
      'public.group_members'::pg_catalog.regclass,
      'public.group_mute_operations'::pg_catalog.regclass
    )
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  ) THEN
    RAISE EXCEPTION 'atomic group table/column ACL inventory drifted';
  END IF;

  IF pg_catalog.has_table_privilege(
    'service_role',
    'public.groups',
    'DELETE'
  ) OR pg_catalog.has_table_privilege(
    'service_role',
    'public.group_mute_operations',
    'SELECT'
  ) THEN
    RAISE EXCEPTION 'service_role table authority exceeds the atomic boundary';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.groups'::pg_catalog.regclass
  ) <> 2 OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.group_members'::pg_catalog.regclass
  ) <> 2 OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.group_mute_operations'::pg_catalog.regclass
  ) <> 1 THEN
    RAISE EXCEPTION 'atomic group policy inventory count drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.unnest(ARRAY[
      'public.groups'::pg_catalog.regclass,
      'public.group_members'::pg_catalog.regclass
    ]) AS expected(relation_oid)
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_policy AS policy
      WHERE policy.polrelid = expected.relation_oid
        AND policy.polname = 'browser_read'
        AND policy.polpermissive
        AND policy.polcmd = 'r'
        AND pg_catalog.cardinality(policy.polroles) = 2
        AND v_anon_oid = ANY(policy.polroles)
        AND v_authenticated_oid = ANY(policy.polroles)
        AND pg_catalog.pg_get_expr(
          policy.polqual,
          policy.polrelid
        ) = 'true'
        AND policy.polwithcheck IS NULL
    ) OR NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_policy AS policy
      WHERE policy.polrelid = expected.relation_oid
        AND policy.polname = 'server_role_mutation'
        AND policy.polpermissive
        AND policy.polcmd = '*'
        AND policy.polroles = ARRAY[v_service_oid]::oid[]
        AND pg_catalog.pg_get_expr(
          policy.polqual,
          policy.polrelid
        ) = 'true'
        AND pg_catalog.pg_get_expr(
          policy.polwithcheck,
          policy.polrelid
        ) = 'true'
    )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.unnest(ARRAY[
      'public.group_mute_operations'::pg_catalog.regclass
    ]) AS expected(relation_oid)
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_policy AS policy
      WHERE policy.polrelid = expected.relation_oid
        AND policy.polname = 'ledger_owner_all'
        AND policy.polpermissive
        AND policy.polcmd = '*'
        AND policy.polroles = ARRAY[v_postgres_oid]::oid[]
        AND pg_catalog.pg_get_expr(
          policy.polqual,
          policy.polrelid
        ) = 'true'
        AND pg_catalog.pg_get_expr(
          policy.polwithcheck,
          policy.polrelid
        ) = 'true'
    )
  ) THEN
    RAISE EXCEPTION 'atomic group policy definition drifted';
  END IF;
END
$exact_table_authority$;

DO $exact_role_inheritance$
DECLARE
  v_postgres_oid oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'postgres'
  );
  v_service_oid oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'service_role'
  );
BEGIN
  IF EXISTS (
    WITH RECURSIVE service_inheritors(member_oid) AS (
      SELECT membership.member
      FROM pg_catalog.pg_auth_members AS membership
      JOIN pg_catalog.pg_roles AS member_role
        ON member_role.oid = membership.member
      WHERE membership.roleid = v_service_oid
        AND member_role.rolinherit
      UNION
      SELECT membership.member
      FROM pg_catalog.pg_auth_members AS membership
      JOIN service_inheritors AS inherited
        ON membership.roleid = inherited.member_oid
      JOIN pg_catalog.pg_roles AS member_role
        ON member_role.oid = membership.member
      WHERE member_role.rolinherit
    )
    SELECT 1
    FROM service_inheritors AS inherited
    WHERE inherited.member_oid <> v_postgres_oid
  ) OR EXISTS (
    WITH RECURSIVE service_inherits(role_oid) AS (
      SELECT membership.roleid
      FROM pg_catalog.pg_auth_members AS membership
      JOIN pg_catalog.pg_roles AS service_role_row
        ON service_role_row.oid = membership.member
      WHERE membership.member = v_service_oid
        AND service_role_row.rolinherit
      UNION
      SELECT membership.roleid
      FROM pg_catalog.pg_auth_members AS membership
      JOIN service_inherits AS inherited
        ON membership.member = inherited.role_oid
      JOIN pg_catalog.pg_roles AS inherited_role
        ON inherited_role.oid = membership.member
      WHERE inherited_role.rolinherit
    )
    SELECT 1
    FROM service_inherits
  ) THEN
    RAISE EXCEPTION 'service_role effective inheritance boundary drifted';
  END IF;
END
$exact_role_inheritance$;

DO $exact_ledger_schema$
DECLARE
  v_postgres_oid oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'postgres'
  );
  v_sequence regclass := pg_catalog.pg_get_serial_sequence(
    'public.group_mute_operations',
    'sequence_id'
  )::pg_catalog.regclass;
BEGIN
  IF EXISTS (
    WITH expected(
      relation_name,
      column_name,
      type_oid,
      required_not_null,
      identity_kind,
      default_expression
    ) AS (
      VALUES
        ('group_mute_operations', 'operation_id', 'uuid'::pg_catalog.regtype, true, '', NULL),
        ('group_mute_operations', 'sequence_id', 'bigint'::pg_catalog.regtype, true, 'a', NULL),
        ('group_mute_operations', 'actor_id', 'uuid'::pg_catalog.regtype, true, '', NULL),
        ('group_mute_operations', 'group_id', 'uuid'::pg_catalog.regtype, true, '', NULL),
        ('group_mute_operations', 'target_id', 'uuid'::pg_catalog.regtype, true, '', NULL),
        ('group_mute_operations', 'action', 'text'::pg_catalog.regtype, true, '', NULL),
        ('group_mute_operations', 'muted_until', 'timestamptz'::pg_catalog.regtype, false, '', NULL),
        ('group_mute_operations', 'reason', 'text'::pg_catalog.regtype, false, '', NULL),
        ('group_mute_operations', 'initial_applied', 'boolean'::pg_catalog.regtype, true, '', NULL),
        ('group_mute_operations', 'evidence_kind', 'text'::pg_catalog.regtype, true, '', NULL),
        ('group_mute_operations', 'evidence_operation_id', 'uuid'::pg_catalog.regtype, false, '', NULL),
        ('group_mute_operations', 'evidence_audit_id', 'uuid'::pg_catalog.regtype, true, '', NULL),
        ('group_mute_operations', 'evidence_actor_id', 'uuid'::pg_catalog.regtype, true, '', NULL),
        ('group_mute_operations', 'evidence_action', 'text'::pg_catalog.regtype, true, '', NULL),
        ('group_mute_operations', 'evidence_details', 'jsonb'::pg_catalog.regtype, true, '', NULL),
        ('group_mute_operations', 'audit_log_id', 'uuid'::pg_catalog.regtype, false, '', NULL),
        ('group_mute_operations', 'previous_muted_until', 'timestamptz'::pg_catalog.regtype, false, '', NULL),
        ('group_mute_operations', 'previous_reason', 'text'::pg_catalog.regtype, false, '', NULL),
        ('group_mute_operations', 'previous_muted_by', 'uuid'::pg_catalog.regtype, false, '', NULL),
        ('group_mute_operations', 'result_group_name', 'text'::pg_catalog.regtype, true, '', NULL),
        ('group_mute_operations', 'result_muted_until', 'timestamptz'::pg_catalog.regtype, false, '', NULL),
        ('group_mute_operations', 'result_reason', 'text'::pg_catalog.regtype, false, '', NULL),
        ('group_mute_operations', 'result_muted_by', 'uuid'::pg_catalog.regtype, false, '', NULL),
        ('group_mute_operations', 'created_at', 'timestamptz'::pg_catalog.regtype, true, '', 'clock_timestamp()')
    ),
    actual AS (
      SELECT
        relation.relname::text AS relation_name,
        attribute.attname::text AS column_name,
        attribute.atttypid AS type_oid,
        attribute.attnotnull AS required_not_null,
        attribute.attidentity::text AS identity_kind,
        attribute.attgenerated::text AS generated_kind,
        attribute.atttypmod,
        attribute.attcollation,
        type_row.typcollation AS type_collation,
        attribute.attstattarget,
        attribute.attcompression::text AS compression_kind,
        attribute.attinhcount,
        attribute.attislocal,
        attribute.atthasmissing,
        pg_catalog.pg_get_expr(
          default_row.adbin,
          default_row.adrelid
        ) AS default_expression
      FROM pg_catalog.pg_class AS relation
      JOIN pg_catalog.pg_attribute AS attribute
        ON attribute.attrelid = relation.oid
       AND attribute.attnum > 0
       AND NOT attribute.attisdropped
      JOIN pg_catalog.pg_type AS type_row
        ON type_row.oid = attribute.atttypid
      LEFT JOIN pg_catalog.pg_attrdef AS default_row
        ON default_row.adrelid = attribute.attrelid
       AND default_row.adnum = attribute.attnum
      WHERE relation.oid = 'public.group_mute_operations'::pg_catalog.regclass
    )
    SELECT 1
    FROM expected
    FULL JOIN actual
      USING (relation_name, column_name)
    WHERE expected.column_name IS NULL
       OR actual.column_name IS NULL
       OR actual.type_oid IS DISTINCT FROM expected.type_oid
       OR actual.required_not_null
         IS DISTINCT FROM expected.required_not_null
       OR actual.identity_kind IS DISTINCT FROM expected.identity_kind
       OR actual.generated_kind <> ''
       OR actual.atttypmod <> -1
       OR actual.attcollation IS DISTINCT FROM actual.type_collation
       OR actual.attstattarget <> -1
       OR actual.compression_kind <> ''
       OR actual.attinhcount <> 0
       OR NOT actual.attislocal
       OR actual.atthasmissing
       OR (
         expected.identity_kind <> 'a'
         AND actual.default_expression
           IS DISTINCT FROM expected.default_expression
       )
  ) THEN
    RAISE EXCEPTION 'atomic operation ledger column inventory drifted';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid =
      'public.group_mute_operations'::pg_catalog.regclass
  ) <> 11 OR EXISTS (
    WITH expected(
      relation_oid,
      constraint_name,
      constraint_type,
      definition_md5
    ) AS (
      VALUES
        ('public.group_mute_operations'::pg_catalog.regclass, 'group_mute_operations_pkey', 'p', 'f59b9d798d6d843ea6ea10575b2ae406'),
        ('public.group_mute_operations'::pg_catalog.regclass, 'group_mute_operations_sequence_id_key', 'u', '03498d2562e00807ef051f56f06cf1d0'),
        ('public.group_mute_operations'::pg_catalog.regclass, 'group_mute_operations_audit_log_id_key', 'u', 'c4d30f6c415e13e1604551f0bd991e7d'),
        ('public.group_mute_operations'::pg_catalog.regclass, 'group_mute_operations_action_check', 'c', '62c60688ee14805eaf89a25d598ad0c8'),
        ('public.group_mute_operations'::pg_catalog.regclass, 'group_mute_operations_evidence_action_check', 'c', '0d6c71a91b86158ea5dae9bdb7bab5dd'),
        ('public.group_mute_operations'::pg_catalog.regclass, 'group_mute_operations_evidence_kind_check', 'c', '184dff38349b37f07e651a24eac33cb2'),
        ('public.group_mute_operations'::pg_catalog.regclass, 'group_mute_operations_evidence_details_check', 'c', '465fb27d7a3536a57ace938c6f06bdb0'),
        ('public.group_mute_operations'::pg_catalog.regclass, 'group_mute_operations_reason_check', 'c', '4b3793069a2f1f00c701da98f0bd5980'),
        ('public.group_mute_operations'::pg_catalog.regclass, 'group_mute_operations_request_result_check', 'c', '380f570e6cbac74a1b8a9c66af953fc5'),
        ('public.group_mute_operations'::pg_catalog.regclass, 'group_mute_operations_evidence_check', 'c', '0e53d151e85bb538fd44aa9a5d7a9679'),
        ('public.group_mute_operations'::pg_catalog.regclass, 'group_mute_operations_group_name_check', 'c', 'a36b4cd320b83a3806e813ae2073b50e')
    )
    SELECT 1
    FROM expected
    LEFT JOIN pg_catalog.pg_constraint AS constraint_row
      ON constraint_row.conrelid = expected.relation_oid
     AND constraint_row.conname = expected.constraint_name
    WHERE constraint_row.oid IS NULL
       OR constraint_row.contype IS DISTINCT FROM expected.constraint_type
       OR pg_catalog.md5(
         pg_catalog.pg_get_constraintdef(constraint_row.oid, false)
       ) IS DISTINCT FROM expected.definition_md5
       OR NOT constraint_row.convalidated
       OR constraint_row.condeferrable
       OR constraint_row.condeferred
       OR constraint_row.conparentid <> 0
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid =
      'public.group_mute_operations'::pg_catalog.regclass
      AND constraint_row.contype = 'f'
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.confrelid =
      'public.group_mute_operations'::pg_catalog.regclass
      AND constraint_row.contype = 'f'
  ) THEN
    RAISE EXCEPTION 'atomic operation ledger constraint inventory drifted';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_index AS index_row
    WHERE index_row.indrelid =
      'public.group_mute_operations'::pg_catalog.regclass
  ) <> 5 OR EXISTS (
    WITH expected(
      relation_oid,
      index_name,
      key_numbers,
      key_count,
      index_options,
      unique_index,
      primary_index,
      predicate_expression,
      definition_md5
    ) AS (
      VALUES
        ('public.group_mute_operations'::pg_catalog.regclass, 'group_mute_operations_pkey', '1', 1, '0', true, true, NULL::text, 'a2d942ef4db0582a6904693ff3ec3303'),
        ('public.group_mute_operations'::pg_catalog.regclass, 'group_mute_operations_sequence_id_key', '2', 1, '0', true, false, NULL::text, 'f310d6826f2fd82252040208efaba39b'),
        ('public.group_mute_operations'::pg_catalog.regclass, 'group_mute_operations_audit_log_id_key', '16', 1, '0', true, false, NULL::text, '88e7a5abc68445983907d95d36cfba54'),
        ('public.group_mute_operations'::pg_catalog.regclass, 'group_mute_operations_target_sequence_idx', '4 5 2', 3, '0 0 3', false, false, NULL::text, 'f879fec8e709f32de5fc2b8345ad2407'),
        ('public.group_mute_operations'::pg_catalog.regclass, 'group_mute_operations_latest_applied_idx', '4 5 2', 3, '0 0 3', false, false, 'initial_applied', '6d6d62037c3ebe80b5dbd3d8a0ec1240')
    )
    SELECT 1
    FROM expected
    LEFT JOIN pg_catalog.pg_class AS index_relation
      ON index_relation.relnamespace = 'public'::pg_catalog.regnamespace
     AND index_relation.relname = expected.index_name
    LEFT JOIN pg_catalog.pg_index AS index_row
      ON index_row.indexrelid = index_relation.oid
    WHERE index_row.indexrelid IS NULL
       OR index_row.indrelid <> expected.relation_oid
       OR index_row.indisunique IS DISTINCT FROM expected.unique_index
       OR index_row.indisprimary IS DISTINCT FROM expected.primary_index
       OR NOT index_row.indisvalid
       OR NOT index_row.indisready
       OR NOT index_row.indislive
       OR index_row.indnatts <> expected.key_count
       OR index_row.indnkeyatts <> expected.key_count
       OR index_row.indkey::text <> expected.key_numbers
       OR index_row.indoption::text <> expected.index_options
       OR index_row.indexprs IS NOT NULL
       OR pg_catalog.pg_get_expr(index_row.indpred, index_row.indrelid)
         IS DISTINCT FROM expected.predicate_expression
       OR index_relation.relowner <> v_postgres_oid
       OR pg_catalog.md5(
         pg_catalog.pg_get_indexdef(index_row.indexrelid)
       ) IS DISTINCT FROM expected.definition_md5
  ) THEN
    RAISE EXCEPTION 'atomic operation ledger index inventory drifted';
  END IF;

  IF v_sequence IS NULL OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS sequence_relation
    JOIN pg_catalog.pg_namespace AS sequence_namespace
      ON sequence_namespace.oid = sequence_relation.relnamespace
    JOIN pg_catalog.pg_sequence AS sequence_definition
      ON sequence_definition.seqrelid = sequence_relation.oid
    WHERE sequence_relation.oid = v_sequence
      AND sequence_relation.relkind = 'S'
      AND sequence_relation.relpersistence = 'p'
      AND sequence_relation.relowner = v_postgres_oid
      AND sequence_namespace.nspname = 'public'
      AND sequence_relation.relname =
        'group_mute_operations_sequence_id_seq'
      AND sequence_definition.seqtypid = 'bigint'::pg_catalog.regtype
      AND sequence_definition.seqstart = 1
      AND sequence_definition.seqincrement = 1
      AND sequence_definition.seqmax = 9223372036854775807
      AND sequence_definition.seqmin = 1
      AND sequence_definition.seqcache = 1
      AND NOT sequence_definition.seqcycle
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS sequence_relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        sequence_relation.relacl,
        pg_catalog.acldefault('S', sequence_relation.relowner)
      )
    ) AS acl_entry
    WHERE sequence_relation.oid = v_sequence
      AND acl_entry.grantee <> sequence_relation.relowner
  ) THEN
    RAISE EXCEPTION 'group mute ledger identity sequence drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid =
      'public.group_mute_operations'::pg_catalog.regclass
      AND NOT trigger_row.tgisinternal
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_inherits AS inheritance
    WHERE inheritance.inhrelid =
      'public.group_mute_operations'::pg_catalog.regclass
      OR inheritance.inhparent =
        'public.group_mute_operations'::pg_catalog.regclass
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_rewrite AS rewrite_rule
    WHERE rewrite_rule.ev_class =
      'public.group_mute_operations'::pg_catalog.regclass
  ) OR pg_catalog.obj_description(
    'public.group_mute_operations'::pg_catalog.regclass,
    'pg_class'
  ) IS DISTINCT FROM 'atomic-group-mute-operation-ledger:v2'
  THEN
    RAISE EXCEPTION 'atomic operation ledger structural boundary drifted';
  END IF;
END
$exact_ledger_schema$;

NOTIFY pgrst, 'reload schema';

COMMIT;
