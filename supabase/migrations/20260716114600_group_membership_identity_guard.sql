-- Membership identity is delete-and-insert only. Allowing an UPDATE to move a
-- row between group/user edges bypasses the canonical INSERT/DELETE counter.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '90s';

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('group-application-authority-migrations', 0)
);

DO $preflight$
DECLARE
  required_role text;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = 'public.groups'::pg_catalog.regclass
      AND relation.relkind IN ('r', 'p')
      AND pg_catalog.pg_get_userbyid(relation.relowner) = 'postgres'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = 'public.group_members'::pg_catalog.regclass
      AND relation.relkind IN ('r', 'p')
      AND pg_catalog.pg_get_userbyid(relation.relowner) = 'postgres'
  ) THEN
    RAISE EXCEPTION 'postgres-owned group membership relations are required';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('groups', 'id', 'uuid'::pg_catalog.regtype),
        ('groups', 'member_count', 'integer'::pg_catalog.regtype),
        ('group_members', 'group_id', 'uuid'::pg_catalog.regtype),
        ('group_members', 'user_id', 'uuid'::pg_catalog.regtype)
    ) AS required_column(relation_name, column_name, type_oid)
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_attribute AS attribute
      WHERE attribute.attrelid = pg_catalog.to_regclass(
        'public.' || required_column.relation_name
      )
        AND attribute.attname = required_column.column_name
        AND attribute.atttypid = required_column.type_oid
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
    )
  ) THEN
    RAISE EXCEPTION 'group membership identity columns are incompatible';
  END IF;

  FOREACH required_role IN ARRAY ARRAY[
    'anon',
    'authenticated',
    'service_role'
  ]::text[]
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_roles AS role_info
      WHERE role_info.rolname = required_role
    ) THEN
      RAISE EXCEPTION 'required database role is missing: %', required_role;
    END IF;
  END LOOP;

  IF pg_catalog.to_regprocedure(
    'public.sync_group_member_count()'
  ) IS NULL OR pg_catalog.to_regprocedure(
    'public.serialize_group_membership_edge()'
  ) IS NULL OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_info
    WHERE trigger_info.tgrelid = 'public.group_members'::pg_catalog.regclass
      AND trigger_info.tgname = 'trg_sync_group_member_count'
      AND trigger_info.tgfoid =
        'public.sync_group_member_count()'::pg_catalog.regprocedure
      AND trigger_info.tgenabled = 'O'
      AND trigger_info.tgtype = 13
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_info
    WHERE trigger_info.tgrelid = 'public.group_members'::pg_catalog.regclass
      AND trigger_info.tgname = 'trg_group_members_05_serialize_edge'
      AND trigger_info.tgfoid =
        'public.serialize_group_membership_edge()'::pg_catalog.regprocedure
      AND trigger_info.tgenabled = 'O'
  ) THEN
    RAISE EXCEPTION 'atomic membership migration 20260716113900 must be applied first';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_info
    WHERE function_info.pronamespace = 'public'::pg_catalog.regnamespace
      AND function_info.proname = 'reject_group_membership_identity_update'
      AND pg_catalog.pg_get_function_identity_arguments(function_info.oid) <> ''
  ) THEN
    RAISE EXCEPTION 'unexpected group membership identity guard overload exists';
  END IF;
END
$preflight$;

-- The lock closes the interval between recalibrating a stale cache and making
-- every future identity move fail transactionally.
LOCK TABLE public.groups, public.group_members IN ACCESS EXCLUSIVE MODE;

CREATE OR REPLACE FUNCTION public.reject_group_membership_identity_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF NEW.group_id IS DISTINCT FROM OLD.group_id
    OR NEW.user_id IS DISTINCT FROM OLD.user_id
  THEN
    RAISE EXCEPTION 'group membership identity is immutable; delete and insert instead'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;

ALTER FUNCTION public.reject_group_membership_identity_update()
  OWNER TO postgres;

DO $converge_function_acl$
DECLARE
  signature pg_catalog.regprocedure :=
    'public.reject_group_membership_identity_update()'::pg_catalog.regprocedure;
  function_owner oid;
  grantee_info record;
BEGIN
  SELECT function_info.proowner
  INTO function_owner
  FROM pg_catalog.pg_proc AS function_info
  WHERE function_info.oid = signature;

  FOR grantee_info IN
    SELECT DISTINCT acl.grantee, role_info.rolname
    FROM pg_catalog.pg_proc AS function_info
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        function_info.proacl,
        pg_catalog.acldefault('f', function_info.proowner)
      )
    ) AS acl
    LEFT JOIN pg_catalog.pg_roles AS role_info
      ON role_info.oid = acl.grantee
    WHERE function_info.oid = signature
      AND acl.grantee <> function_owner
  LOOP
    IF grantee_info.grantee = 0 THEN
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON FUNCTION %s FROM PUBLIC',
        signature
      );
    ELSIF grantee_info.rolname IS NOT NULL THEN
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON FUNCTION %s FROM %I',
        signature,
        grantee_info.rolname
      );
    END IF;
  END LOOP;

  REVOKE ALL ON FUNCTION public.reject_group_membership_identity_update()
    FROM PUBLIC, anon, authenticated, service_role;
END
$converge_function_acl$;

DROP TRIGGER IF EXISTS trg_group_members_99_identity_immutable
  ON public.group_members;
-- AFTER UPDATE observes the final row even if an unrelated BEFORE trigger
-- changes identity during a role-only statement. Raising rolls back every
-- trigger side effect and prevents the count cache from drifting.
CREATE TRIGGER trg_group_members_99_identity_immutable
  AFTER UPDATE ON public.group_members
  FOR EACH ROW
  EXECUTE FUNCTION public.reject_group_membership_identity_update();

UPDATE public.groups AS target_group
SET member_count = exact_count.member_count
FROM (
  SELECT
    counted_group.id AS group_id,
    pg_catalog.count(member.user_id)::integer AS member_count
  FROM public.groups AS counted_group
  LEFT JOIN public.group_members AS member
    ON member.group_id = counted_group.id
  GROUP BY counted_group.id
) AS exact_count
WHERE target_group.id = exact_count.group_id
  AND target_group.member_count IS DISTINCT FROM exact_count.member_count;

DO $postflight$
DECLARE
  guard_signature pg_catalog.regprocedure :=
    'public.reject_group_membership_identity_update()'::pg_catalog.regprocedure;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_info
    WHERE function_info.oid = guard_signature
      AND function_info.prosecdef
      AND pg_catalog.pg_get_userbyid(function_info.proowner) = 'postgres'
      AND function_info.proconfig =
        ARRAY['search_path=pg_catalog, public']::text[]
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_info
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        function_info.proacl,
        pg_catalog.acldefault('f', function_info.proowner)
      )
    ) AS acl
    WHERE function_info.oid = guard_signature
      AND acl.privilege_type = 'EXECUTE'
      AND acl.grantee <> function_info.proowner
  ) THEN
    RAISE EXCEPTION 'group membership identity guard security drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_info
    WHERE function_info.pronamespace = 'public'::pg_catalog.regnamespace
      AND function_info.proname = 'reject_group_membership_identity_update'
      AND function_info.oid <> guard_signature
  ) THEN
    RAISE EXCEPTION 'unexpected group membership identity guard overload remains';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_info
    WHERE trigger_info.tgrelid = 'public.group_members'::pg_catalog.regclass
      AND trigger_info.tgname = 'trg_group_members_99_identity_immutable'
      AND trigger_info.tgfoid = guard_signature
      AND trigger_info.tgenabled = 'O'
      AND NOT trigger_info.tgisinternal
      AND trigger_info.tgtype = 17
      AND trigger_info.tgattr = ''::pg_catalog.int2vector
  ) THEN
    RAISE EXCEPTION 'group membership identity guard trigger drifted';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_info
    WHERE trigger_info.tgrelid = 'public.group_members'::pg_catalog.regclass
      AND trigger_info.tgname = 'trg_sync_group_member_count'
      AND trigger_info.tgfoid =
        'public.sync_group_member_count()'::pg_catalog.regprocedure
      AND trigger_info.tgenabled = 'O'
      AND trigger_info.tgtype = 13
  ) THEN
    RAISE EXCEPTION 'canonical insert/delete member counter drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.groups AS target_group
    WHERE target_group.member_count IS DISTINCT FROM (
      SELECT pg_catalog.count(*)::integer
      FROM public.group_members AS member
      WHERE member.group_id = target_group.id
    )
  ) THEN
    RAISE EXCEPTION 'member count calibration failed before identity lock';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
