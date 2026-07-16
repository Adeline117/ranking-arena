-- Make Pro official-group allocation and membership a single database
-- transaction.  The route and webhooks may execute the three canonical RPCs;
-- no non-owner role can write either registry table directly.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('group-application-authority-migrations', 0)
);

DO $preflight$
DECLARE
  v_postgres_oid oid := (
    SELECT role_row.oid FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'postgres'
  );
  v_service_oid oid := (
    SELECT role_row.oid FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'service_role'
  );
  v_authenticator_oid oid := (
    SELECT role_row.oid FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'authenticator'
  );
  v_entitlement oid := pg_catalog.to_regprocedure(
    'public.has_current_global_pro_entitlement(uuid)'
  );
  v_existing pg_catalog.regprocedure;
BEGIN
  IF v_postgres_oid IS NULL
    OR v_service_oid IS NULL
    OR v_authenticator_oid IS NULL
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.unnest(ARRAY['anon', 'authenticated']::name[])
        AS required(role_name)
      LEFT JOIN pg_catalog.pg_roles AS role_row
        ON role_row.rolname = required.role_name
      WHERE role_row.oid IS NULL
    )
  THEN
    RAISE EXCEPTION 'atomic Pro official groups require the application database roles';
  END IF;

  IF pg_catalog.to_regprocedure('auth.role()') IS NULL OR (
    SELECT function_row.prorettype
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = 'auth.role()'::pg_catalog.regprocedure
  ) <> 'text'::pg_catalog.regtype THEN
    RAISE EXCEPTION 'atomic Pro official groups require auth.role() returning text';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = pg_catalog.to_regclass('auth.users')
      AND relation.relkind IN ('r', 'p')
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.unnest(ARRAY[
      'public.user_profiles',
      'public.groups',
      'public.group_members',
      'public.group_bans',
      'public.pro_official_groups',
      'public.pro_official_group_members'
    ]::text[]) AS required(relation_name)
    LEFT JOIN pg_catalog.pg_class AS relation
      ON relation.oid = pg_catalog.to_regclass(required.relation_name)
     AND relation.relkind IN ('r', 'p')
     AND relation.relowner = v_postgres_oid
    WHERE relation.oid IS NULL
  ) THEN
    RAISE EXCEPTION 'postgres-owned Pro official-group dependency relation is missing';
  END IF;

  IF pg_catalog.to_regtype('public.group_visibility') IS NULL
    OR pg_catalog.to_regtype('public.member_role') IS NULL
    OR NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_enum AS enum_row
      WHERE enum_row.enumtypid = 'public.group_visibility'::pg_catalog.regtype
        AND enum_row.enumlabel = 'apply'
    )
    OR NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_enum AS enum_row
      WHERE enum_row.enumtypid = 'public.member_role'::pg_catalog.regtype
        AND enum_row.enumlabel = 'owner'
    )
    OR NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_enum AS enum_row
      WHERE enum_row.enumtypid = 'public.member_role'::pg_catalog.regtype
        AND enum_row.enumlabel = 'member'
    )
  THEN
    RAISE EXCEPTION 'Pro official-group enum contract is incompatible';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('auth', 'users', 'id', 'uuid'::pg_catalog.regtype, true),
        ('public', 'user_profiles', 'id', 'uuid'::pg_catalog.regtype, true),
        ('public', 'user_profiles', 'email', 'text'::pg_catalog.regtype, false),
        ('public', 'user_profiles', 'deleted_at', 'timestamptz'::pg_catalog.regtype, false),
        ('public', 'user_profiles', 'banned_at', 'timestamptz'::pg_catalog.regtype, false),
        ('public', 'user_profiles', 'is_banned', 'boolean'::pg_catalog.regtype, false),
        ('public', 'user_profiles', 'ban_expires_at', 'timestamptz'::pg_catalog.regtype, false),
        ('public', 'groups', 'id', 'uuid'::pg_catalog.regtype, true),
        ('public', 'groups', 'name', 'text'::pg_catalog.regtype, true),
        ('public', 'groups', 'name_en', 'text'::pg_catalog.regtype, false),
        ('public', 'groups', 'description', 'text'::pg_catalog.regtype, false),
        ('public', 'groups', 'description_en', 'text'::pg_catalog.regtype, false),
        ('public', 'groups', 'created_by', 'uuid'::pg_catalog.regtype, true),
        ('public', 'groups', 'visibility', 'public.group_visibility'::pg_catalog.regtype, true),
        ('public', 'groups', 'is_premium_only', 'boolean'::pg_catalog.regtype, false),
        ('public', 'groups', 'member_count', 'integer'::pg_catalog.regtype, true),
        ('public', 'groups', 'dissolved_at', 'timestamptz'::pg_catalog.regtype, false),
        ('public', 'group_members', 'group_id', 'uuid'::pg_catalog.regtype, true),
        ('public', 'group_members', 'user_id', 'uuid'::pg_catalog.regtype, true),
        ('public', 'group_members', 'role', 'public.member_role'::pg_catalog.regtype, true),
        ('public', 'group_bans', 'group_id', 'uuid'::pg_catalog.regtype, true),
        ('public', 'group_bans', 'user_id', 'uuid'::pg_catalog.regtype, true),
        ('public', 'pro_official_groups', 'id', 'uuid'::pg_catalog.regtype, true),
        ('public', 'pro_official_groups', 'group_id', 'uuid'::pg_catalog.regtype, true),
        ('public', 'pro_official_groups', 'group_number', 'integer'::pg_catalog.regtype, true),
        ('public', 'pro_official_groups', 'is_active', 'boolean'::pg_catalog.regtype, true),
        ('public', 'pro_official_groups', 'current_member_count', 'integer'::pg_catalog.regtype, true),
        ('public', 'pro_official_group_members', 'id', 'uuid'::pg_catalog.regtype, true),
        ('public', 'pro_official_group_members', 'user_id', 'uuid'::pg_catalog.regtype, true),
        ('public', 'pro_official_group_members', 'pro_group_id', 'uuid'::pg_catalog.regtype, true),
        ('public', 'pro_official_group_members', 'created_at', 'timestamptz'::pg_catalog.regtype, true)
    ) AS required_column(
      schema_name,
      relation_name,
      column_name,
      type_oid,
      required_not_null
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
    RAISE EXCEPTION 'Pro official-group dependency columns are incompatible';
  END IF;

  -- One registry row per actor and one official config per generic group/number
  -- are the database-level idempotency and allocator authority.
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid =
        'public.pro_official_group_members'::pg_catalog.regclass
      AND constraint_row.contype = 'u'
      AND constraint_row.convalidated
      AND NOT constraint_row.condeferrable
      AND NOT constraint_row.condeferred
      AND constraint_row.conkey = ARRAY[
        (
          SELECT attribute.attnum
          FROM pg_catalog.pg_attribute AS attribute
          WHERE attribute.attrelid = constraint_row.conrelid
            AND attribute.attname = 'user_id'
        )
      ]::smallint[]
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid =
        'public.pro_official_groups'::pg_catalog.regclass
      AND constraint_row.contype = 'u'
      AND constraint_row.convalidated
      AND NOT constraint_row.condeferrable
      AND NOT constraint_row.condeferred
      AND constraint_row.conkey IN (
        ARRAY[
          (
            SELECT attribute.attnum
            FROM pg_catalog.pg_attribute AS attribute
            WHERE attribute.attrelid = constraint_row.conrelid
              AND attribute.attname = 'group_id'
          )
        ]::smallint[],
        ARRAY[
          (
            SELECT attribute.attnum
            FROM pg_catalog.pg_attribute AS attribute
            WHERE attribute.attrelid = constraint_row.conrelid
              AND attribute.attname = 'group_number'
          )
        ]::smallint[]
      )
    GROUP BY constraint_row.conrelid
    HAVING pg_catalog.count(*) = 2
  ) THEN
    RAISE EXCEPTION 'Pro official-group unique-key authority is incompatible';
  END IF;

  IF v_entitlement IS NULL OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_entitlement
      AND function_row.proowner = v_postgres_oid
      AND function_row.prorettype = 'boolean'::pg_catalog.regtype
      AND function_row.prosecdef
      AND function_row.provolatile = 's'
      AND function_row.proparallel = 'u'
      AND function_row.prokind = 'f'
      AND function_row.proconfig =
        ARRAY['search_path=pg_catalog, pg_temp']::text[]
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(function_row.proacl, pg_catalog.acldefault('f', function_row.proowner))
    ) AS acl_entry
    WHERE function_row.oid = v_entitlement
      AND acl_entry.privilege_type = 'EXECUTE'
      AND acl_entry.grantee <> v_postgres_oid
  ) THEN
    RAISE EXCEPTION '20260716176100 global Pro entitlement helper is missing or unsafe';
  END IF;

  IF pg_catalog.to_regprocedure('public.sync_group_member_count()') IS NULL
    OR pg_catalog.to_regprocedure('public.serialize_group_membership_edge()') IS NULL
  THEN
    RAISE EXCEPTION 'canonical group membership triggers must be installed first';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.group_members'::pg_catalog.regclass
      AND trigger_row.tgfoid =
        'public.sync_group_member_count()'::pg_catalog.regprocedure
      AND trigger_row.tgenabled = 'O'
      AND NOT trigger_row.tgisinternal
  ) <> 1 OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.group_members'::pg_catalog.regclass
      AND trigger_row.tgname = 'trg_group_members_05_serialize_edge'
      AND trigger_row.tgfoid =
        'public.serialize_group_membership_edge()'::pg_catalog.regprocedure
      AND trigger_row.tgenabled = 'O'
      AND NOT trigger_row.tgisinternal
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.group_members'::pg_catalog.regclass
      AND trigger_row.tgname = 'trg_sync_group_member_count'
      AND trigger_row.tgfoid = 'public.sync_group_member_count()'::pg_catalog.regprocedure
      AND trigger_row.tgenabled = 'O'
      AND NOT trigger_row.tgisinternal
  ) THEN
    RAISE EXCEPTION 'canonical group membership trigger contract drifted';
  END IF;

  -- Supabase's gateway may SET ROLE service_role but must not inherit it.
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_auth_members AS membership
    WHERE membership.roleid = v_service_oid
      AND membership.member = v_authenticator_oid
      AND NOT membership.admin_option
      AND NOT membership.inherit_option
      AND membership.set_option
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_auth_members AS membership
    WHERE membership.roleid = v_service_oid
      AND membership.member NOT IN (v_authenticator_oid, v_postgres_oid)
  ) OR EXISTS (
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
        AND (membership.inherit_option OR membership.set_option)
      UNION
      SELECT membership.roleid
      FROM pg_catalog.pg_auth_members AS membership
      JOIN service_inherits AS inherited
        ON membership.member = inherited.role_oid
      WHERE membership.inherit_option OR membership.set_option
    )
    SELECT 1 FROM service_inherits
  ) OR EXISTS (
    WITH RECURSIVE browser_authority(role_oid) AS (
      SELECT membership.roleid
      FROM pg_catalog.pg_roles AS browser_role
      JOIN pg_catalog.pg_auth_members AS membership
        ON membership.member = browser_role.oid
       AND (membership.inherit_option OR membership.set_option)
      WHERE browser_role.rolname IN ('anon', 'authenticated')
      UNION
      SELECT membership.roleid
      FROM browser_authority AS inherited
      JOIN pg_catalog.pg_auth_members AS membership
        ON membership.member = inherited.role_oid
      WHERE membership.inherit_option OR membership.set_option
    )
    SELECT 1 FROM browser_authority AS inherited
    WHERE inherited.role_oid IN (v_service_oid, v_postgres_oid)
  ) THEN
    RAISE EXCEPTION 'service_role has an unsafe effective authority edge';
  END IF;

  FOR v_existing IN
    SELECT function_row.oid::pg_catalog.regprocedure
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.pronamespace = 'public'::pg_catalog.regnamespace
      AND function_row.proname IN (
        'get_pro_official_group_atomic',
        'join_pro_official_group_atomic',
        'leave_pro_official_group_atomic'
      )
      AND (
        (
          function_row.proname IN (
            'get_pro_official_group_atomic',
            'leave_pro_official_group_atomic'
          )
          AND pg_catalog.pg_get_function_identity_arguments(function_row.oid)
            <> 'p_actor_id uuid'
        )
        OR (
          function_row.proname = 'join_pro_official_group_atomic'
          AND pg_catalog.pg_get_function_identity_arguments(function_row.oid)
            <> 'p_actor_id uuid, p_owner_id uuid'
        )
      )
  LOOP
    RAISE EXCEPTION 'incompatible Pro official-group RPC overload exists: %', v_existing;
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.pronamespace = 'public'::pg_catalog.regnamespace
      AND (
        (
          function_row.proname IN (
            'get_pro_official_group_atomic',
            'leave_pro_official_group_atomic'
          )
          AND pg_catalog.pg_get_function_identity_arguments(function_row.oid)
            = 'p_actor_id uuid'
        )
        OR (
          function_row.proname = 'join_pro_official_group_atomic'
          AND pg_catalog.pg_get_function_identity_arguments(function_row.oid)
            = 'p_actor_id uuid, p_owner_id uuid'
        )
      )
      AND (
        function_row.prokind <> 'f'
        OR function_row.prorettype <> 'jsonb'::pg_catalog.regtype
      )
  ) THEN
    RAISE EXCEPTION 'canonical Pro official-group RPC return contract is incompatible';
  END IF;
END
$preflight$;

LOCK TABLE
  public.groups,
  public.group_members,
  public.pro_official_groups,
  public.pro_official_group_members
IN ACCESS EXCLUSIVE MODE;

DROP TRIGGER IF EXISTS trg_group_members_07_guard_pro_official
  ON public.group_members;
DROP TRIGGER IF EXISTS trg_pro_official_members_20_sync_count
  ON public.pro_official_group_members;

DROP FUNCTION IF EXISTS public.get_user_pro_official_group(uuid);
DROP FUNCTION IF EXISTS public.join_pro_official_group(uuid);
DROP FUNCTION IF EXISTS public.leave_pro_official_group(uuid);
DROP FUNCTION IF EXISTS public.create_pro_official_group_atomic(uuid);
DROP FUNCTION IF EXISTS public.adjust_pro_group_member_count(uuid, integer);

-- Remove registry rows which cannot lawfully produce a live member edge.  The
-- temporary ledger lets both edges be removed from the same transaction.
CREATE TEMPORARY TABLE pg_temp.invalid_pro_official_memberships
ON COMMIT DROP
AS
SELECT
  official_member.user_id,
  official_member.pro_group_id,
  official_group.group_id
FROM public.pro_official_group_members AS official_member
JOIN public.pro_official_groups AS official_group
  ON official_group.id = official_member.pro_group_id
JOIN public.groups AS target_group
  ON target_group.id = official_group.group_id
WHERE NOT official_group.is_active
   OR target_group.dissolved_at IS NOT NULL
   OR target_group.created_by = official_member.user_id
   OR NOT public.has_current_global_pro_entitlement(official_member.user_id)
   OR EXISTS (
     SELECT 1
     FROM public.group_bans AS ban
     WHERE ban.group_id = official_group.group_id
       AND ban.user_id = official_member.user_id
   );

DELETE FROM public.group_members AS member
USING pg_temp.invalid_pro_official_memberships AS invalid_membership
WHERE member.group_id = invalid_membership.group_id
  AND member.user_id = invalid_membership.user_id
  AND member.role <> 'owner'::public.member_role;

DELETE FROM public.pro_official_group_members AS official_member
USING pg_temp.invalid_pro_official_memberships AS invalid_membership
WHERE official_member.user_id = invalid_membership.user_id
  AND official_member.pro_group_id = invalid_membership.pro_group_id;

-- An official group has exactly one non-registry edge: its configured owner.
-- Remove historical joins which bypassed the official registry before repairing
-- the opposite (registry-only) half-edge below.
DELETE FROM public.group_members AS member
USING public.pro_official_groups AS official_group,
      public.groups AS target_group
WHERE member.group_id = official_group.group_id
  AND target_group.id = official_group.group_id
  AND member.user_id <> target_group.created_by
  AND NOT EXISTS (
    SELECT 1
    FROM public.pro_official_group_members AS official_member
    WHERE official_member.pro_group_id = official_group.id
      AND official_member.user_id = member.user_id
  );

-- Repair a historical registry-only half join before installing the guard.
INSERT INTO public.group_members (group_id, user_id, role)
SELECT
  official_group.group_id,
  official_member.user_id,
  'member'::public.member_role
FROM public.pro_official_group_members AS official_member
JOIN public.pro_official_groups AS official_group
  ON official_group.id = official_member.pro_group_id
WHERE official_group.is_active
  AND NOT EXISTS (
    SELECT 1
    FROM public.group_members AS member
    WHERE member.group_id = official_group.group_id
      AND member.user_id = official_member.user_id
  )
ON CONFLICT (group_id, user_id) DO NOTHING;

-- The configured creator is the sole owner edge and never consumes a subscriber
-- slot. Existing rows are normalized in place without touching either counter.
INSERT INTO public.group_members (group_id, user_id, role)
SELECT
  official_group.group_id,
  target_group.created_by,
  'owner'::public.member_role
FROM public.pro_official_groups AS official_group
JOIN public.groups AS target_group ON target_group.id = official_group.group_id
ON CONFLICT (group_id, user_id) DO UPDATE
SET role = 'owner'::public.member_role
WHERE public.group_members.role IS DISTINCT FROM 'owner'::public.member_role;

-- Registry membership owns the subscriber role; generic moderation and join
-- functions cannot turn a paid slot into a second owner edge.
UPDATE public.group_members AS member
SET role = 'member'::public.member_role
FROM public.pro_official_group_members AS official_member
JOIN public.pro_official_groups AS official_group
  ON official_group.id = official_member.pro_group_id
WHERE member.group_id = official_group.group_id
  AND member.user_id = official_member.user_id
  AND member.role IS DISTINCT FROM 'member'::public.member_role;

UPDATE public.pro_official_groups AS official_group
SET current_member_count = (
  SELECT pg_catalog.count(*)::integer
  FROM public.pro_official_group_members AS official_member
  WHERE official_member.pro_group_id = official_group.id
);

-- groups.member_count has a separate canonical owner: the generic membership
-- edge trigger. Recount it independently so the official-registry trigger never
-- double-applies to the public group cache.
UPDATE public.groups AS target_group
SET member_count = (
  SELECT pg_catalog.count(*)::integer
  FROM public.group_members AS member
  WHERE member.group_id = target_group.id
)
FROM public.pro_official_groups AS official_group
WHERE official_group.group_id = target_group.id
  AND target_group.member_count IS DISTINCT FROM (
    SELECT pg_catalog.count(*)::integer
    FROM public.group_members AS member
    WHERE member.group_id = target_group.id
  );

DO $capacity_repair_attestation$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.pro_official_groups AS official_group
    WHERE official_group.group_number <= 0
       OR official_group.current_member_count < 0
       OR official_group.current_member_count > 500
  ) THEN
    RAISE EXCEPTION 'historical Pro official-group capacity requires manual redistribution';
  END IF;
END
$capacity_repair_attestation$;

ALTER TABLE public.pro_official_groups
  DROP CONSTRAINT IF EXISTS pro_official_groups_group_number_positive,
  DROP CONSTRAINT IF EXISTS pro_official_groups_member_count_bounds;
ALTER TABLE public.pro_official_groups
  ADD CONSTRAINT pro_official_groups_group_number_positive
    CHECK (group_number > 0),
  ADD CONSTRAINT pro_official_groups_member_count_bounds
    CHECK (current_member_count BETWEEN 0 AND 500);

CREATE OR REPLACE FUNCTION public.sync_pro_official_member_count()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE public.pro_official_groups AS official_group
    SET current_member_count = official_group.current_member_count + 1
    WHERE official_group.id = NEW.pro_group_id;
    RETURN NEW;
  END IF;

  UPDATE public.pro_official_groups AS official_group
  SET current_member_count = official_group.current_member_count - 1
  WHERE official_group.id = OLD.pro_group_id;
  RETURN OLD;
END
$function$;

ALTER FUNCTION public.sync_pro_official_member_count() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sync_pro_official_member_count()
  FROM PUBLIC, anon, authenticated, service_role, authenticator;

CREATE TRIGGER trg_pro_official_members_20_sync_count
  AFTER INSERT OR DELETE ON public.pro_official_group_members
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_pro_official_member_count();

CREATE OR REPLACE FUNCTION public.guard_pro_official_group_member_edge()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_old_creator_id uuid;
  v_new_creator_id uuid;
  v_old_pro_group_id uuid;
  v_new_pro_group_id uuid;
  v_old_registered boolean := false;
  v_new_registered boolean := false;
  v_account_inactive boolean := false;
BEGIN
  IF TG_OP IN ('DELETE', 'UPDATE') THEN
    SELECT official_group.id, target_group.created_by
    INTO v_old_pro_group_id, v_old_creator_id
    FROM public.pro_official_groups AS official_group
    JOIN public.groups AS target_group ON target_group.id = official_group.group_id
    WHERE official_group.group_id = OLD.group_id;

    IF v_old_pro_group_id IS NOT NULL THEN
      SELECT EXISTS (
        SELECT 1
        FROM public.pro_official_group_members AS official_member
        WHERE official_member.pro_group_id = v_old_pro_group_id
          AND official_member.user_id = OLD.user_id
      ) INTO v_old_registered;
    END IF;
  END IF;

  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    SELECT official_group.id, target_group.created_by
    INTO v_new_pro_group_id, v_new_creator_id
    FROM public.pro_official_groups AS official_group
    JOIN public.groups AS target_group ON target_group.id = official_group.group_id
    WHERE official_group.group_id = NEW.group_id;

    IF v_new_pro_group_id IS NOT NULL THEN
      SELECT EXISTS (
        SELECT 1
        FROM public.pro_official_group_members AS official_member
        WHERE official_member.pro_group_id = v_new_pro_group_id
          AND official_member.user_id = NEW.user_id
      ) INTO v_new_registered;
    END IF;
  END IF;

  IF TG_OP = 'DELETE' AND v_old_registered THEN
    SELECT NOT EXISTS (
      SELECT 1
      FROM public.user_profiles AS profile
      WHERE profile.id = OLD.user_id
        AND profile.deleted_at IS NULL
    ) INTO v_account_inactive;

    IF v_account_inactive THEN
      DELETE FROM public.pro_official_group_members AS official_member
      WHERE official_member.pro_group_id = v_old_pro_group_id
        AND official_member.user_id = OLD.user_id;
      RETURN OLD;
    END IF;
  END IF;

  IF TG_OP = 'DELETE' AND v_old_registered THEN
    RAISE EXCEPTION 'Pro official membership registry must be removed before its group edge'
      USING ERRCODE = '42501';
  END IF;

  IF TG_OP = 'UPDATE'
    AND (
      NEW.group_id IS DISTINCT FROM OLD.group_id
      OR NEW.user_id IS DISTINCT FROM OLD.user_id
    )
  THEN
    IF v_old_registered THEN
      RAISE EXCEPTION 'old Pro official registry edge must be removed before membership identity changes'
        USING ERRCODE = '42501';
    END IF;

    IF v_new_pro_group_id IS NOT NULL
      AND NEW.user_id IS DISTINCT FROM v_new_creator_id
      AND NOT v_new_registered
    THEN
      RAISE EXCEPTION 'new Pro official registry edge must exist before membership identity changes'
        USING ERRCODE = '42501';
    END IF;

    IF v_old_pro_group_id IS NOT NULL OR v_new_pro_group_id IS NOT NULL THEN
      RAISE EXCEPTION 'Pro official membership identity is immutable'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF v_new_pro_group_id IS NOT NULL THEN
    IF NEW.user_id = v_new_creator_id THEN
      IF NEW.role <> 'owner'::public.member_role THEN
        RAISE EXCEPTION 'Pro official-group creator must retain its owner edge'
          USING ERRCODE = '23514';
      END IF;
    ELSIF NOT v_new_registered THEN
      RAISE EXCEPTION 'Pro official membership edge is managed only by its atomic RPC'
        USING ERRCODE = '42501';
    ELSIF NEW.role <> 'member'::public.member_role THEN
      RAISE EXCEPTION 'Pro official subscriber edge must retain the member role'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$function$;

ALTER FUNCTION public.guard_pro_official_group_member_edge() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.guard_pro_official_group_member_edge()
  FROM PUBLIC, anon, authenticated, service_role, authenticator;

CREATE TRIGGER trg_group_members_07_guard_pro_official
  BEFORE INSERT OR UPDATE OF group_id, user_id, role OR DELETE
  ON public.group_members
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_pro_official_group_member_edge();

CREATE OR REPLACE FUNCTION public.get_pro_official_group_atomic(
  p_actor_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_pro_group_id uuid;
  v_group_id uuid;
  v_group_number integer;
  v_current_member_count integer;
  v_is_active boolean;
  v_joined_at timestamptz;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_actor_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;
  IF NOT public.has_current_global_pro_entitlement(p_actor_id) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'pro_required');
  END IF;

  SELECT
    official_group.id,
    official_group.group_id,
    official_group.group_number,
    official_group.current_member_count,
    official_group.is_active,
    official_member.created_at
  INTO
    v_pro_group_id,
    v_group_id,
    v_group_number,
    v_current_member_count,
    v_is_active,
    v_joined_at
  FROM public.pro_official_group_members AS official_member
  JOIN public.pro_official_groups AS official_group
    ON official_group.id = official_member.pro_group_id
  WHERE official_member.user_id = p_actor_id;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_member');
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'status', 'found',
    'pro_group_id', v_pro_group_id,
    'group_id', v_group_id,
    'group_number', v_group_number,
    'current_member_count', v_current_member_count,
    'is_active', v_is_active,
    'joined_at', v_joined_at
  );
END
$function$;

ALTER FUNCTION public.get_pro_official_group_atomic(uuid) OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.join_pro_official_group_atomic(
  p_actor_id uuid,
  p_owner_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_capacity constant integer := 500;
  v_pro_group_id uuid;
  v_group_id uuid;
  v_group_number integer;
  v_group_creator uuid;
  v_group_dissolved_at timestamptz;
  v_group_active boolean;
  v_was_registered boolean := false;
  v_create_group boolean := false;
  v_actor_deleted_at timestamptz;
  v_actor_banned_at timestamptz;
  v_actor_is_banned boolean;
  v_actor_ban_expires_at timestamptz;
  v_owner_deleted_at timestamptz;
  v_owner_banned_at timestamptz;
  v_owner_is_banned boolean;
  v_owner_ban_expires_at timestamptz;
  v_registry_count integer;
  v_official_count integer;
  v_group_member_count integer;
  v_exact_group_member_count integer;
  v_name text;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_actor_id IS NULL OR p_owner_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('pro-official-group-assignment', 0)
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('pro-official-group-user:' || p_actor_id::text, 0)
  );

  SELECT official_group.id, official_group.group_id, official_group.group_number
  INTO v_pro_group_id, v_group_id, v_group_number
  FROM public.pro_official_group_members AS official_member
  JOIN public.pro_official_groups AS official_group
    ON official_group.id = official_member.pro_group_id
  WHERE official_member.user_id = p_actor_id;
  v_was_registered := FOUND;

  IF NOT v_was_registered THEN
    SELECT official_group.id, official_group.group_id, official_group.group_number
    INTO v_pro_group_id, v_group_id, v_group_number
    FROM public.pro_official_groups AS official_group
    JOIN public.groups AS target_group ON target_group.id = official_group.group_id
    WHERE official_group.is_active
      AND target_group.dissolved_at IS NULL
      AND (
        SELECT pg_catalog.count(*)
        FROM public.pro_official_group_members AS official_member
        WHERE official_member.pro_group_id = official_group.id
      ) < v_capacity
    ORDER BY official_group.group_number
    LIMIT 1;

    IF NOT FOUND THEN
      v_create_group := true;
      v_pro_group_id := pg_catalog.gen_random_uuid();
      v_group_id := pg_catalog.gen_random_uuid();
      SELECT COALESCE(pg_catalog.max(official_group.group_number), 0) + 1
      INTO v_group_number
      FROM public.pro_official_groups AS official_group;

      LOOP
        v_name := 'Arena Pro 会员群 #' || v_group_number::text;
        EXIT WHEN NOT EXISTS (
          SELECT 1 FROM public.groups AS target_group
          WHERE pg_catalog.lower(target_group.name) = pg_catalog.lower(v_name)
        );
        v_group_number := v_group_number + 1;
      END LOOP;
    END IF;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'group-membership:' || v_group_id::text || ':' || p_actor_id::text,
      0
    )
  );

  SELECT
    profile.deleted_at,
    profile.banned_at,
    COALESCE(profile.is_banned, false),
    profile.ban_expires_at
  INTO
    v_actor_deleted_at,
    v_actor_banned_at,
    v_actor_is_banned,
    v_actor_ban_expires_at
  FROM public.user_profiles AS profile
  WHERE profile.id = p_actor_id
  FOR UPDATE;

  IF NOT FOUND
    OR v_actor_deleted_at IS NOT NULL
    OR v_actor_banned_at IS NOT NULL
    OR (
      v_actor_is_banned
      AND (
        v_actor_ban_expires_at IS NULL
        OR v_actor_ban_expires_at > pg_catalog.clock_timestamp()
      )
    )
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'account_inactive');
  END IF;
  IF NOT public.has_current_global_pro_entitlement(p_actor_id) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'pro_required');
  END IF;

  IF v_create_group THEN
    IF p_owner_id IS DISTINCT FROM p_actor_id THEN
      PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
          'group-membership:' || v_group_id::text || ':' || p_owner_id::text,
          0
        )
      );
    END IF;

    SELECT
      profile.deleted_at,
      profile.banned_at,
      COALESCE(profile.is_banned, false),
      profile.ban_expires_at
    INTO
      v_owner_deleted_at,
      v_owner_banned_at,
      v_owner_is_banned,
      v_owner_ban_expires_at
    FROM public.user_profiles AS profile
    WHERE profile.id = p_owner_id
    FOR UPDATE;

    IF NOT FOUND
      OR v_owner_deleted_at IS NOT NULL
      OR v_owner_banned_at IS NOT NULL
      OR (
        v_owner_is_banned
        AND (
          v_owner_ban_expires_at IS NULL
          OR v_owner_ban_expires_at > pg_catalog.clock_timestamp()
        )
      )
    THEN
      RETURN pg_catalog.jsonb_build_object('status', 'owner_not_found');
    END IF;

    INSERT INTO public.groups (
      id,
      name,
      name_en,
      description,
      description_en,
      created_by,
      visibility,
      is_premium_only
    ) VALUES (
      v_group_id,
      v_name,
      'Arena Pro Member Group #' || v_group_number::text,
      '欢迎加入 Arena Pro 会员专属群！在这里可以与其他 Pro 会员交流心得、获取官方支持。',
      'Welcome to the Arena Pro member group. Chat with other Pro members and get official support.',
      p_owner_id,
      'apply'::public.group_visibility,
      true
    );

    INSERT INTO public.pro_official_groups (
      id,
      group_id,
      group_number,
      is_active,
      current_member_count
    ) VALUES (
      v_pro_group_id,
      v_group_id,
      v_group_number,
      true,
      0
    );

    INSERT INTO public.group_members (group_id, user_id, role)
    VALUES (v_group_id, p_owner_id, 'owner'::public.member_role);
  ELSE
    SELECT
      target_group.created_by,
      target_group.dissolved_at,
      official_group.is_active
    INTO v_group_creator, v_group_dissolved_at, v_group_active
    FROM public.groups AS target_group
    JOIN public.pro_official_groups AS official_group
      ON official_group.group_id = target_group.id
    WHERE target_group.id = v_group_id
      AND official_group.id = v_pro_group_id
    FOR UPDATE OF target_group, official_group;

    IF NOT FOUND OR NOT v_group_active OR v_group_dissolved_at IS NOT NULL THEN
      RETURN pg_catalog.jsonb_build_object('status', 'group_unavailable');
    END IF;

    SELECT pg_catalog.count(*)::integer
    INTO v_registry_count
    FROM public.pro_official_group_members AS official_member
    WHERE official_member.pro_group_id = v_pro_group_id;
    IF NOT v_was_registered AND v_registry_count >= v_capacity THEN
      RETURN pg_catalog.jsonb_build_object('status', 'group_full');
    END IF;
  END IF;

  SELECT target_group.created_by
  INTO v_group_creator
  FROM public.groups AS target_group
  WHERE target_group.id = v_group_id;

  IF EXISTS (
    SELECT 1 FROM public.group_bans AS ban
    WHERE ban.group_id = v_group_id
      AND ban.user_id = p_actor_id
  ) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'banned');
  END IF;

  -- The configured owner is already represented by the owner edge and does
  -- not consume one of the 500 subscriber slots.
  IF v_group_creator = p_actor_id AND NOT v_was_registered THEN
    SELECT official_group.current_member_count, target_group.member_count
    INTO v_official_count, v_group_member_count
    FROM public.pro_official_groups AS official_group
    JOIN public.groups AS target_group ON target_group.id = official_group.group_id
    WHERE official_group.id = v_pro_group_id;

    SELECT pg_catalog.count(*)::integer
    INTO v_exact_group_member_count
    FROM public.group_members AS member
    WHERE member.group_id = v_group_id;

    IF v_official_count <> (
      SELECT pg_catalog.count(*)::integer
      FROM public.pro_official_group_members AS official_member
      WHERE official_member.pro_group_id = v_pro_group_id
    ) OR v_group_member_count <> v_exact_group_member_count THEN
      RAISE EXCEPTION 'Pro official owner membership evidence did not converge';
    END IF;

    RETURN pg_catalog.jsonb_build_object(
      'status', 'already_member',
      'pro_group_id', v_pro_group_id,
      'group_id', v_group_id,
      'group_number', v_group_number,
      'official_member_count', v_official_count,
      'registry_member_count', v_official_count,
      'group_member_count', v_group_member_count
    );
  END IF;

  IF NOT v_was_registered THEN
    INSERT INTO public.pro_official_group_members (user_id, pro_group_id)
    VALUES (p_actor_id, v_pro_group_id);
  END IF;

  INSERT INTO public.group_members (group_id, user_id, role)
  VALUES (v_group_id, p_actor_id, 'member'::public.member_role)
  ON CONFLICT (group_id, user_id) DO NOTHING;

  SELECT pg_catalog.count(*)::integer
  INTO v_registry_count
  FROM public.pro_official_group_members AS official_member
  WHERE official_member.pro_group_id = v_pro_group_id;

  SELECT official_group.current_member_count, target_group.member_count
  INTO v_official_count, v_group_member_count
  FROM public.pro_official_groups AS official_group
  JOIN public.groups AS target_group ON target_group.id = official_group.group_id
  WHERE official_group.id = v_pro_group_id;

  SELECT pg_catalog.count(*)::integer
  INTO v_exact_group_member_count
  FROM public.group_members AS member
  WHERE member.group_id = v_group_id;

  IF v_registry_count > v_capacity
    OR v_official_count <> v_registry_count
    OR v_group_member_count <> v_exact_group_member_count
    OR NOT EXISTS (
      SELECT 1 FROM public.group_members AS member
      WHERE member.group_id = v_group_id
        AND member.user_id = p_actor_id
        AND member.role = 'member'::public.member_role
    )
  THEN
    RAISE EXCEPTION 'Pro official join evidence did not converge';
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'status', CASE WHEN v_was_registered THEN 'already_member' ELSE 'joined' END,
    'pro_group_id', v_pro_group_id,
    'group_id', v_group_id,
    'group_number', v_group_number,
    'official_member_count', v_official_count,
    'registry_member_count', v_registry_count,
    'group_member_count', v_group_member_count
  );
END
$function$;

ALTER FUNCTION public.join_pro_official_group_atomic(uuid, uuid) OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.leave_pro_official_group_atomic(
  p_actor_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_pro_group_id uuid;
  v_group_id uuid;
  v_group_creator uuid;
  v_registry_count integer;
  v_official_count integer;
  v_group_member_count integer;
  v_exact_group_member_count integer;
  v_deleted_count integer;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_actor_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('pro-official-group-assignment', 0)
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('pro-official-group-user:' || p_actor_id::text, 0)
  );

  SELECT official_group.id, official_group.group_id, target_group.created_by
  INTO v_pro_group_id, v_group_id, v_group_creator
  FROM public.pro_official_group_members AS official_member
  JOIN public.pro_official_groups AS official_group
    ON official_group.id = official_member.pro_group_id
  JOIN public.groups AS target_group ON target_group.id = official_group.group_id
  WHERE official_member.user_id = p_actor_id;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_member');
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'group-membership:' || v_group_id::text || ':' || p_actor_id::text,
      0
    )
  );

  PERFORM 1
  FROM public.groups AS target_group
  WHERE target_group.id = v_group_id
  FOR UPDATE;
  PERFORM 1
  FROM public.pro_official_groups AS official_group
  WHERE official_group.id = v_pro_group_id
  FOR UPDATE;

  -- Structural ordering is the authority proof: registry first on leave, then
  -- the generic group edge.  A failure in either statement rolls both back.
  DELETE FROM public.pro_official_group_members AS official_member
  WHERE official_member.user_id = p_actor_id
    AND official_member.pro_group_id = v_pro_group_id;
  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
  IF v_deleted_count <> 1 THEN
    RAISE EXCEPTION 'Pro official leave removed % registry rows', v_deleted_count;
  END IF;

  DELETE FROM public.group_members AS member
  WHERE member.group_id = v_group_id
    AND member.user_id = p_actor_id
    AND member.user_id <> v_group_creator;

  SELECT pg_catalog.count(*)::integer
  INTO v_registry_count
  FROM public.pro_official_group_members AS official_member
  WHERE official_member.pro_group_id = v_pro_group_id;

  SELECT official_group.current_member_count, target_group.member_count
  INTO v_official_count, v_group_member_count
  FROM public.pro_official_groups AS official_group
  JOIN public.groups AS target_group ON target_group.id = official_group.group_id
  WHERE official_group.id = v_pro_group_id;

  SELECT pg_catalog.count(*)::integer
  INTO v_exact_group_member_count
  FROM public.group_members AS member
  WHERE member.group_id = v_group_id;

  IF v_official_count <> v_registry_count
    OR v_group_member_count <> v_exact_group_member_count
    OR EXISTS (
    SELECT 1 FROM public.group_members AS member
    WHERE member.group_id = v_group_id
      AND member.user_id = p_actor_id
      AND member.user_id <> v_group_creator
    )
  THEN
    RAISE EXCEPTION 'Pro official leave evidence did not converge';
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'status', 'left',
    'pro_group_id', v_pro_group_id,
    'group_id', v_group_id,
    'official_member_count', v_official_count,
    'registry_member_count', v_registry_count,
    'group_member_count', v_group_member_count
  );
END
$function$;

ALTER FUNCTION public.leave_pro_official_group_atomic(uuid) OWNER TO postgres;

DO $converge_table_authority$
DECLARE
  v_relation_name text;
  v_relation_oid oid;
  v_relation_owner oid;
  v_column_list text;
  v_grantee record;
  v_policy record;
BEGIN
  FOREACH v_relation_name IN ARRAY ARRAY[
    'pro_official_groups',
    'pro_official_group_members'
  ]::text[]
  LOOP
    v_relation_oid := pg_catalog.to_regclass('public.' || v_relation_name);
    SELECT relation.relowner INTO v_relation_owner
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = v_relation_oid;

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

    FOR v_grantee IN
      SELECT DISTINCT acl_entry.grantee, role_row.rolname
      FROM pg_catalog.pg_class AS relation
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
      ) AS acl_entry
      LEFT JOIN pg_catalog.pg_roles AS role_row ON role_row.oid = acl_entry.grantee
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
        || 'FROM PUBLIC, anon, authenticated, service_role, authenticator',
      v_relation_name
    );

    SELECT pg_catalog.string_agg(
      pg_catalog.format('%I', attribute.attname),
      ', ' ORDER BY attribute.attnum
    )
    INTO v_column_list
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = v_relation_oid
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped;

    IF v_column_list IS NOT NULL THEN
      FOR v_grantee IN
        SELECT DISTINCT acl_entry.grantee, role_row.rolname
        FROM pg_catalog.pg_attribute AS attribute
        CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl_entry
        LEFT JOIN pg_catalog.pg_roles AS role_row ON role_row.oid = acl_entry.grantee
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

    EXECUTE pg_catalog.format(
      'ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',
      v_relation_name
    );
    EXECUTE pg_catalog.format(
      'ALTER TABLE public.%I NO FORCE ROW LEVEL SECURITY',
      v_relation_name
    );
  END LOOP;
END
$converge_table_authority$;

DO $converge_function_authority$
DECLARE
  v_signature pg_catalog.regprocedure;
  v_owner oid;
  v_grantee record;
BEGIN
  FOREACH v_signature IN ARRAY ARRAY[
    'public.get_pro_official_group_atomic(uuid)'::pg_catalog.regprocedure,
    'public.join_pro_official_group_atomic(uuid,uuid)'::pg_catalog.regprocedure,
    'public.leave_pro_official_group_atomic(uuid)'::pg_catalog.regprocedure,
    'public.sync_pro_official_member_count()'::pg_catalog.regprocedure,
    'public.guard_pro_official_group_member_edge()'::pg_catalog.regprocedure
  ]
  LOOP
    SELECT function_row.proowner INTO v_owner
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_signature;

    FOR v_grantee IN
      SELECT DISTINCT acl_entry.grantee, role_row.rolname
      FROM pg_catalog.pg_proc AS function_row
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(function_row.proacl, pg_catalog.acldefault('f', function_row.proowner))
      ) AS acl_entry
      LEFT JOIN pg_catalog.pg_roles AS role_row ON role_row.oid = acl_entry.grantee
      WHERE function_row.oid = v_signature
        AND acl_entry.grantee <> v_owner
    LOOP
      IF v_grantee.grantee = 0 THEN
        EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', v_signature);
      ELSIF v_grantee.rolname IS NOT NULL THEN
        EXECUTE pg_catalog.format(
          'REVOKE ALL ON FUNCTION %s FROM %I',
          v_signature,
          v_grantee.rolname
        );
      END IF;
    END LOOP;
  END LOOP;
END
$converge_function_authority$;

REVOKE ALL ON FUNCTION public.get_pro_official_group_atomic(uuid)
  FROM PUBLIC, anon, authenticated, service_role, authenticator;
REVOKE ALL ON FUNCTION public.join_pro_official_group_atomic(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role, authenticator;
REVOKE ALL ON FUNCTION public.leave_pro_official_group_atomic(uuid)
  FROM PUBLIC, anon, authenticated, service_role, authenticator;
GRANT EXECUTE ON FUNCTION public.get_pro_official_group_atomic(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.join_pro_official_group_atomic(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.leave_pro_official_group_atomic(uuid) TO service_role;

DO $postflight$
DECLARE
  v_postgres_oid oid := (
    SELECT role_row.oid FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'postgres'
  );
  v_service_oid oid := (
    SELECT role_row.oid FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'service_role'
  );
  v_authenticator_oid oid := (
    SELECT role_row.oid FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'authenticator'
  );
  v_relation_name text;
  v_relation_oid oid;
  v_signature pg_catalog.regprocedure;
BEGIN
  FOREACH v_relation_name IN ARRAY ARRAY[
    'pro_official_groups',
    'pro_official_group_members'
  ]::text[]
  LOOP
    v_relation_oid := pg_catalog.to_regclass('public.' || v_relation_name);
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_class AS relation
      WHERE relation.oid = v_relation_oid
        AND relation.relowner = v_postgres_oid
        AND relation.relrowsecurity
        AND NOT relation.relforcerowsecurity
    ) OR EXISTS (
      SELECT 1 FROM pg_catalog.pg_policy AS policy
      WHERE policy.polrelid = v_relation_oid
    ) OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS relation
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
      ) AS acl_entry
      WHERE relation.oid = v_relation_oid
        AND acl_entry.grantee <> v_postgres_oid
    ) OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_attribute AS attribute
      CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl_entry
      WHERE attribute.attrelid = v_relation_oid
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
        AND acl_entry.grantee <> v_postgres_oid
    ) THEN
      RAISE EXCEPTION 'Pro official-group table authority did not converge: %',
        v_relation_name;
    END IF;
  END LOOP;

  FOREACH v_signature IN ARRAY ARRAY[
    'public.sync_pro_official_member_count()'::pg_catalog.regprocedure,
    'public.guard_pro_official_group_member_edge()'::pg_catalog.regprocedure
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS function_row
      WHERE function_row.oid = v_signature
        AND function_row.proowner = v_postgres_oid
        AND function_row.prorettype = 'trigger'::pg_catalog.regtype
        AND function_row.prosecdef
        AND function_row.provolatile = 'v'
        AND function_row.proparallel = 'u'
        AND function_row.prokind = 'f'
        AND function_row.proconfig =
          ARRAY['search_path=pg_catalog, pg_temp']::text[]
    ) OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS function_row
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(function_row.proacl, pg_catalog.acldefault('f', function_row.proowner))
      ) AS acl_entry
      WHERE function_row.oid = v_signature
        AND acl_entry.privilege_type = 'EXECUTE'
        AND acl_entry.grantee <> v_postgres_oid
    ) THEN
      RAISE EXCEPTION 'Pro official-group trigger helper security drifted: %',
        v_signature;
    END IF;
  END LOOP;

  FOREACH v_signature IN ARRAY ARRAY[
    'public.get_pro_official_group_atomic(uuid)'::pg_catalog.regprocedure,
    'public.join_pro_official_group_atomic(uuid,uuid)'::pg_catalog.regprocedure,
    'public.leave_pro_official_group_atomic(uuid)'::pg_catalog.regprocedure
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS function_row
      WHERE function_row.oid = v_signature
        AND function_row.proowner = v_postgres_oid
        AND function_row.prorettype = 'jsonb'::pg_catalog.regtype
        AND function_row.prosecdef
        AND function_row.provolatile = 'v'
        AND function_row.proparallel = 'u'
        AND function_row.prokind = 'f'
        AND function_row.proconfig = ARRAY[
          'search_path=pg_catalog, pg_temp',
          'lock_timeout=5s'
        ]::text[]
    ) OR NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS function_row
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(function_row.proacl, pg_catalog.acldefault('f', function_row.proowner))
      ) AS acl_entry
      WHERE function_row.oid = v_signature
        AND acl_entry.privilege_type = 'EXECUTE'
        AND acl_entry.grantee = v_service_oid
        AND acl_entry.grantor = v_postgres_oid
        AND NOT acl_entry.is_grantable
    ) OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS function_row
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(function_row.proacl, pg_catalog.acldefault('f', function_row.proowner))
      ) AS acl_entry
      WHERE function_row.oid = v_signature
        AND acl_entry.privilege_type = 'EXECUTE'
        AND acl_entry.grantee NOT IN (v_postgres_oid, v_service_oid)
    ) THEN
      RAISE EXCEPTION 'Pro official-group RPC security contract drifted: %', v_signature;
    END IF;
  END LOOP;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.group_members'::pg_catalog.regclass
      AND trigger_row.tgfoid =
        'public.guard_pro_official_group_member_edge()'::pg_catalog.regprocedure
      AND NOT trigger_row.tgisinternal
  ) <> 1 OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.group_members'::pg_catalog.regclass
      AND trigger_row.tgname = 'trg_group_members_07_guard_pro_official'
      AND trigger_row.tgenabled = 'O'
      AND trigger_row.tgtype = 31
      AND pg_catalog.cardinality(trigger_row.tgattr::smallint[]) = 3
      AND (
        SELECT attribute.attnum
        FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid = trigger_row.tgrelid
          AND attribute.attname = 'group_id'
      ) = ANY(trigger_row.tgattr::smallint[])
      AND (
        SELECT attribute.attnum
        FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid = trigger_row.tgrelid
          AND attribute.attname = 'user_id'
      ) = ANY(trigger_row.tgattr::smallint[])
      AND (
        SELECT attribute.attnum
        FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid = trigger_row.tgrelid
          AND attribute.attname = 'role'
      ) = ANY(trigger_row.tgattr::smallint[])
      AND NOT trigger_row.tgisinternal
  ) OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.pro_official_group_members'::pg_catalog.regclass
      AND trigger_row.tgfoid =
        'public.sync_pro_official_member_count()'::pg_catalog.regprocedure
      AND NOT trigger_row.tgisinternal
  ) <> 1 OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.pro_official_group_members'::pg_catalog.regclass
      AND trigger_row.tgname = 'trg_pro_official_members_20_sync_count'
      AND trigger_row.tgenabled = 'O'
      AND trigger_row.tgtype = 13
      AND NOT trigger_row.tgisinternal
  ) THEN
    RAISE EXCEPTION 'Pro official-group trigger contract drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.pro_official_groups AS official_group
    WHERE official_group.current_member_count <> (
      SELECT pg_catalog.count(*)::integer
      FROM public.pro_official_group_members AS official_member
      WHERE official_member.pro_group_id = official_group.id
    )
       OR official_group.current_member_count NOT BETWEEN 0 AND 500
       OR official_group.group_number <= 0
  ) OR EXISTS (
    SELECT 1
    FROM public.pro_official_group_members AS official_member
    JOIN public.pro_official_groups AS official_group
      ON official_group.id = official_member.pro_group_id
    WHERE NOT EXISTS (
      SELECT 1 FROM public.group_members AS member
      WHERE member.group_id = official_group.group_id
        AND member.user_id = official_member.user_id
        AND member.role = 'member'::public.member_role
    )
  ) OR EXISTS (
    SELECT 1
    FROM public.group_members AS member
    JOIN public.pro_official_groups AS official_group
      ON official_group.group_id = member.group_id
    JOIN public.groups AS target_group ON target_group.id = official_group.group_id
    WHERE member.user_id <> target_group.created_by
      AND NOT EXISTS (
        SELECT 1
        FROM public.pro_official_group_members AS official_member
        WHERE official_member.pro_group_id = official_group.id
          AND official_member.user_id = member.user_id
      )
  ) OR EXISTS (
    SELECT 1
    FROM public.pro_official_group_members AS official_member
    JOIN public.pro_official_groups AS official_group
      ON official_group.id = official_member.pro_group_id
    JOIN public.groups AS target_group ON target_group.id = official_group.group_id
    WHERE official_member.user_id = target_group.created_by
  ) OR EXISTS (
    SELECT 1
    FROM public.pro_official_groups AS official_group
    JOIN public.groups AS target_group ON target_group.id = official_group.group_id
    WHERE target_group.member_count <> (
      SELECT pg_catalog.count(*)::integer
      FROM public.group_members AS member
      WHERE member.group_id = target_group.id
    )
       OR NOT EXISTS (
         SELECT 1
         FROM public.group_members AS owner_member
         WHERE owner_member.group_id = target_group.id
           AND owner_member.user_id = target_group.created_by
           AND owner_member.role = 'owner'::public.member_role
       )
  ) THEN
    RAISE EXCEPTION 'Pro official-group membership/count reconciliation failed';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.pronamespace = 'public'::pg_catalog.regnamespace
      AND function_row.proname IN (
        'get_user_pro_official_group',
        'join_pro_official_group',
        'leave_pro_official_group',
        'create_pro_official_group_atomic',
        'adjust_pro_group_member_count'
      )
  )
  THEN
    RAISE EXCEPTION 'legacy Pro official-group mutation surface remains callable';
  END IF;

  -- Re-attest the complete gateway role graph after all migration writes.
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_auth_members AS membership
    WHERE membership.roleid = v_service_oid
      AND membership.member = v_authenticator_oid
      AND NOT membership.admin_option
      AND NOT membership.inherit_option
      AND membership.set_option
  ) OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_auth_members AS membership
    WHERE membership.roleid = v_service_oid
      AND membership.member NOT IN (v_authenticator_oid, v_postgres_oid)
  ) OR EXISTS (
    WITH RECURSIVE service_inheritors(member_oid) AS (
      SELECT membership.member
      FROM pg_catalog.pg_auth_members AS membership
      WHERE membership.roleid = v_service_oid AND membership.inherit_option
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
        AND (membership.inherit_option OR membership.set_option)
      UNION
      SELECT membership.roleid
      FROM pg_catalog.pg_auth_members AS membership
      JOIN service_inherits AS inherited
        ON membership.member = inherited.role_oid
      WHERE membership.inherit_option OR membership.set_option
    )
    SELECT 1 FROM service_inherits
  ) OR EXISTS (
    WITH RECURSIVE browser_authority(role_oid) AS (
      SELECT membership.roleid
      FROM pg_catalog.pg_roles AS browser_role
      JOIN pg_catalog.pg_auth_members AS membership
        ON membership.member = browser_role.oid
       AND (membership.inherit_option OR membership.set_option)
      WHERE browser_role.rolname IN ('anon', 'authenticated')
      UNION
      SELECT membership.roleid
      FROM browser_authority AS inherited
      JOIN pg_catalog.pg_auth_members AS membership
        ON membership.member = inherited.role_oid
      WHERE membership.inherit_option OR membership.set_option
    )
    SELECT 1 FROM browser_authority AS inherited
    WHERE inherited.role_oid IN (v_service_oid, v_postgres_oid)
  ) THEN
    RAISE EXCEPTION 'service_role has an unsafe effective authority edge';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
