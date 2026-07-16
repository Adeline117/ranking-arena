-- Ban, kick and unban are one authorization + mutation + audit transaction.
-- Membership join/leave remains owned by 20260716113900 and is not replaced.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '90s';

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('group-application-authority-migrations', 0)
);

DO $preflight$
DECLARE
  required_relation text;
  required_role text;
BEGIN
  FOREACH required_relation IN ARRAY ARRAY[
    'groups',
    'user_profiles',
    'group_members',
    'group_bans',
    'group_audit_log'
  ]::text[]
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS relation
      WHERE relation.oid = pg_catalog.to_regclass('public.' || required_relation)
        AND relation.relkind IN ('r', 'p')
        AND pg_catalog.pg_get_userbyid(relation.relowner) = 'postgres'
    ) THEN
      RAISE EXCEPTION 'postgres-owned moderation relation is missing: public.%',
        required_relation;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('groups', 'id'),
        ('groups', 'created_by'),
        ('groups', 'dissolved_at'),
        ('groups', 'member_count'),
        ('user_profiles', 'id'),
        ('user_profiles', 'deleted_at'),
        ('user_profiles', 'banned_at'),
        ('user_profiles', 'is_banned'),
        ('user_profiles', 'ban_expires_at'),
        ('group_members', 'group_id'),
        ('group_members', 'user_id'),
        ('group_members', 'role'),
        ('group_bans', 'group_id'),
        ('group_bans', 'user_id'),
        ('group_bans', 'banned_by'),
        ('group_bans', 'reason'),
        ('group_audit_log', 'group_id'),
        ('group_audit_log', 'actor_id'),
        ('group_audit_log', 'action'),
        ('group_audit_log', 'target_id'),
        ('group_audit_log', 'details')
    ) AS required_column(relation_name, column_name)
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_attribute AS attribute
      WHERE attribute.attrelid = pg_catalog.to_regclass(
        'public.' || required_column.relation_name
      )
        AND attribute.attname = required_column.column_name
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
    )
  ) THEN
    RAISE EXCEPTION 'required group moderation columns are missing';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('groups', 'id', 'uuid'::pg_catalog.regtype),
        ('groups', 'created_by', 'uuid'::pg_catalog.regtype),
        ('groups', 'dissolved_at', 'timestamptz'::pg_catalog.regtype),
        ('groups', 'member_count', 'integer'::pg_catalog.regtype),
        ('user_profiles', 'id', 'uuid'::pg_catalog.regtype),
        ('user_profiles', 'deleted_at', 'timestamptz'::pg_catalog.regtype),
        ('user_profiles', 'banned_at', 'timestamptz'::pg_catalog.regtype),
        ('user_profiles', 'is_banned', 'boolean'::pg_catalog.regtype),
        ('user_profiles', 'ban_expires_at', 'timestamptz'::pg_catalog.regtype),
        ('group_members', 'group_id', 'uuid'::pg_catalog.regtype),
        ('group_members', 'user_id', 'uuid'::pg_catalog.regtype),
        ('group_members', 'role', 'public.member_role'::pg_catalog.regtype),
        ('group_bans', 'group_id', 'uuid'::pg_catalog.regtype),
        ('group_bans', 'user_id', 'uuid'::pg_catalog.regtype),
        ('group_bans', 'banned_by', 'uuid'::pg_catalog.regtype),
        ('group_bans', 'reason', 'text'::pg_catalog.regtype),
        ('group_audit_log', 'group_id', 'uuid'::pg_catalog.regtype),
        ('group_audit_log', 'actor_id', 'uuid'::pg_catalog.regtype),
        ('group_audit_log', 'action', 'text'::pg_catalog.regtype),
        ('group_audit_log', 'target_id', 'uuid'::pg_catalog.regtype),
        ('group_audit_log', 'details', 'jsonb'::pg_catalog.regtype)
    ) AS required_type(relation_name, column_name, type_oid)
    JOIN pg_catalog.pg_attribute AS attribute
      ON attribute.attrelid = pg_catalog.to_regclass(
        'public.' || required_type.relation_name
      )
     AND attribute.attname = required_type.column_name
     AND attribute.attnum > 0
     AND NOT attribute.attisdropped
    WHERE attribute.atttypid <> required_type.type_oid
  ) THEN
    RAISE EXCEPTION 'group moderation column types are incompatible';
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
    'public.mutate_group_membership_atomic(uuid,uuid,text,boolean)'
  ) IS NULL OR pg_catalog.to_regprocedure(
    'public.redeem_group_invite_atomic(uuid,uuid,text,boolean)'
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
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_info
    WHERE trigger_info.tgrelid = 'public.group_members'::pg_catalog.regclass
      AND trigger_info.tgname = 'trg_group_members_05_serialize_edge'
      AND trigger_info.tgfoid =
        'public.serialize_group_membership_edge()'::pg_catalog.regprocedure
      AND trigger_info.tgenabled = 'O'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_info
    WHERE trigger_info.tgrelid = 'public.group_bans'::pg_catalog.regclass
      AND trigger_info.tgname = 'trg_group_bans_05_serialize_edge'
      AND trigger_info.tgfoid =
        'public.serialize_group_membership_edge()'::pg_catalog.regprocedure
      AND trigger_info.tgenabled = 'O'
  ) THEN
    RAISE EXCEPTION 'atomic membership migration 20260716113900 must be applied first';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_info
    WHERE constraint_info.conrelid =
        'public.group_members'::pg_catalog.regclass
      AND constraint_info.contype = 'p'
      AND constraint_info.convalidated
      AND NOT constraint_info.condeferrable
      AND constraint_info.conkey = ARRAY[
        (
          SELECT attribute.attnum
          FROM pg_catalog.pg_attribute AS attribute
          WHERE attribute.attrelid = constraint_info.conrelid
            AND attribute.attname = 'group_id'
        ),
        (
          SELECT attribute.attnum
          FROM pg_catalog.pg_attribute AS attribute
          WHERE attribute.attrelid = constraint_info.conrelid
            AND attribute.attname = 'user_id'
        )
      ]::smallint[]
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_info
    WHERE constraint_info.conrelid = 'public.group_bans'::pg_catalog.regclass
      AND constraint_info.contype = 'p'
      AND constraint_info.convalidated
      AND NOT constraint_info.condeferrable
      AND constraint_info.conkey = ARRAY[
        (
          SELECT attribute.attnum
          FROM pg_catalog.pg_attribute AS attribute
          WHERE attribute.attrelid = constraint_info.conrelid
            AND attribute.attname = 'group_id'
        ),
        (
          SELECT attribute.attnum
          FROM pg_catalog.pg_attribute AS attribute
          WHERE attribute.attrelid = constraint_info.conrelid
            AND attribute.attname = 'user_id'
        )
      ]::smallint[]
  ) THEN
    RAISE EXCEPTION 'moderation edge primary keys are incompatible';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_enum AS enum_value
    WHERE enum_value.enumtypid = 'public.member_role'::pg_catalog.regtype
      AND enum_value.enumlabel = 'owner'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_enum AS enum_value
    WHERE enum_value.enumtypid = 'public.member_role'::pg_catalog.regtype
      AND enum_value.enumlabel = 'admin'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_enum AS enum_value
    WHERE enum_value.enumtypid = 'public.member_role'::pg_catalog.regtype
      AND enum_value.enumlabel = 'member'
  ) THEN
    RAISE EXCEPTION 'required moderation role labels are missing';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_info
    WHERE function_info.pronamespace = 'public'::pg_catalog.regnamespace
      AND function_info.proname = 'moderate_group_member_atomic'
      AND pg_catalog.pg_get_function_identity_arguments(function_info.oid)
        <> 'p_actor_id uuid, p_group_id uuid, p_target_id uuid, p_action text, p_reason text'
  ) THEN
    RAISE EXCEPTION 'unexpected atomic group moderation overload exists';
  END IF;
END
$preflight$;

LOCK TABLE
  public.groups,
  public.user_profiles,
  public.group_members,
  public.group_bans,
  public.group_audit_log
IN ACCESS EXCLUSIVE MODE;

DO $locked_data_preflight$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.group_members AS member
    JOIN public.group_bans AS ban
      ON ban.group_id = member.group_id
     AND ban.user_id = member.user_id
  ) THEN
    RAISE EXCEPTION 'existing banned memberships require explicit review';
  END IF;
END
$locked_data_preflight$;

-- Group bans remain readable to authenticated group administrators and server
-- routes, but all mutations are owned by the SECURITY DEFINER moderation RPC.
ALTER TABLE public.group_bans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.group_bans FORCE ROW LEVEL SECURITY;

DO $replace_ban_policies$
DECLARE
  policy_info record;
BEGIN
  FOR policy_info IN
    SELECT policy.polname
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.group_bans'::pg_catalog.regclass
  LOOP
    EXECUTE pg_catalog.format(
      'DROP POLICY %I ON public.group_bans',
      policy_info.polname
    );
  END LOOP;
END
$replace_ban_policies$;

DO $converge_ban_acls$
DECLARE
  relation_oid oid := 'public.group_bans'::pg_catalog.regclass;
  relation_owner oid;
  column_list text;
  grantee_info record;
BEGIN
  SELECT relation.relowner
  INTO relation_owner
  FROM pg_catalog.pg_class AS relation
  WHERE relation.oid = relation_oid;

  FOR grantee_info IN
    SELECT DISTINCT acl.grantee, role_info.rolname
    FROM pg_catalog.pg_class AS relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        relation.relacl,
        pg_catalog.acldefault('r', relation.relowner)
      )
    ) AS acl
    LEFT JOIN pg_catalog.pg_roles AS role_info
      ON role_info.oid = acl.grantee
    WHERE relation.oid = relation_oid
      AND acl.grantee <> relation_owner
  LOOP
    IF grantee_info.grantee = 0 THEN
      EXECUTE 'REVOKE ALL PRIVILEGES ON TABLE public.group_bans FROM PUBLIC';
    ELSIF grantee_info.rolname IS NOT NULL THEN
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON TABLE public.group_bans FROM %I',
        grantee_info.rolname
      );
    END IF;
  END LOOP;

  REVOKE ALL PRIVILEGES ON TABLE public.group_bans
    FROM PUBLIC, anon, authenticated, service_role;

  SELECT pg_catalog.string_agg(
    pg_catalog.format('%I', attribute.attname),
    ', '
    ORDER BY attribute.attnum
  )
  INTO column_list
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = relation_oid
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;

  FOR grantee_info IN
    SELECT DISTINCT acl.grantee, role_info.rolname
    FROM pg_catalog.pg_attribute AS attribute
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl
    LEFT JOIN pg_catalog.pg_roles AS role_info
      ON role_info.oid = acl.grantee
    WHERE attribute.attrelid = relation_oid
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND acl.grantee <> relation_owner
  LOOP
    IF grantee_info.grantee = 0 THEN
      EXECUTE pg_catalog.format(
        'REVOKE SELECT (%1$s), INSERT (%1$s), UPDATE (%1$s), REFERENCES (%1$s) '
          || 'ON TABLE public.group_bans FROM PUBLIC',
        column_list
      );
    ELSIF grantee_info.rolname IS NOT NULL THEN
      EXECUTE pg_catalog.format(
        'REVOKE SELECT (%1$s), INSERT (%1$s), UPDATE (%1$s), REFERENCES (%1$s) '
          || 'ON TABLE public.group_bans FROM %2$I',
        column_list,
        grantee_info.rolname
      );
    END IF;
  END LOOP;
END
$converge_ban_acls$;

GRANT SELECT ON TABLE public.group_bans TO authenticated, service_role;

CREATE POLICY internal_owner_mutation
  ON public.group_bans
  AS PERMISSIVE
  FOR ALL
  TO postgres
  USING (true)
  WITH CHECK (true);

CREATE POLICY browser_admin_read
  ON public.group_bans
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.group_members AS administrator
      WHERE administrator.group_id = group_bans.group_id
        AND administrator.user_id = (SELECT auth.uid())
        AND administrator.role IN (
          'owner'::public.member_role,
          'admin'::public.member_role
        )
    )
  );

CREATE POLICY server_read
  ON public.group_bans
  AS PERMISSIVE
  FOR SELECT
  TO service_role
  USING (true);

CREATE OR REPLACE FUNCTION public.reject_banned_group_membership()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_is_banned boolean := false;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM public.group_bans AS ban
    WHERE ban.group_id = NEW.group_id
      AND ban.user_id = NEW.user_id
  )
  INTO v_is_banned;

  IF v_is_banned THEN
    RAISE EXCEPTION 'banned user cannot have group membership'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;

ALTER FUNCTION public.reject_banned_group_membership() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.reject_banned_group_membership()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_group_members_10_reject_ban ON public.group_members;
CREATE TRIGGER trg_group_members_10_reject_ban
  BEFORE INSERT OR UPDATE OF group_id, user_id ON public.group_members
  FOR EACH ROW
  EXECUTE FUNCTION public.reject_banned_group_membership();

CREATE OR REPLACE FUNCTION public.reject_member_group_ban()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_is_member boolean := false;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM public.group_members AS member
    WHERE member.group_id = NEW.group_id
      AND member.user_id = NEW.user_id
  )
  INTO v_is_member;

  IF v_is_member THEN
    RAISE EXCEPTION 'group member must be removed before ban insertion'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;

ALTER FUNCTION public.reject_member_group_ban() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.reject_member_group_ban()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_group_bans_10_reject_member ON public.group_bans;
CREATE TRIGGER trg_group_bans_10_reject_member
  BEFORE INSERT OR UPDATE OF group_id, user_id ON public.group_bans
  FOR EACH ROW
  EXECUTE FUNCTION public.reject_member_group_ban();

CREATE OR REPLACE FUNCTION public.moderate_group_member_atomic(
  p_actor_id uuid,
  p_group_id uuid,
  p_target_id uuid,
  p_action text,
  p_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_actor_profile public.user_profiles%ROWTYPE;
  v_target_profile public.user_profiles%ROWTYPE;
  v_group public.groups%ROWTYPE;
  v_actor_role text;
  v_target_role text;
  v_reason text := NULLIF(pg_catalog.btrim(COALESCE(p_reason, '')), '');
  v_member_count integer;
  v_actor_profile_found boolean := false;
  v_target_profile_found boolean := false;
  v_group_found boolean := false;
  v_actor_is_member boolean := false;
  v_target_is_member boolean := false;
  v_target_is_banned boolean := false;
  v_affected_count integer := 0;
  v_first_edge text;
  v_second_edge text;
BEGIN
  IF p_actor_id IS NULL
    OR p_group_id IS NULL
    OR p_target_id IS NULL
    OR p_action IS NULL
    OR p_action NOT IN ('ban', 'kick', 'unban')
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;
  IF pg_catalog.char_length(COALESCE(p_reason, '')) > 500 THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid_reason');
  END IF;
  IF p_action IN ('ban', 'kick') AND p_actor_id = p_target_id THEN
    RETURN pg_catalog.jsonb_build_object('status', 'self_forbidden');
  END IF;

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

  PERFORM 1
  FROM public.user_profiles AS profile
  WHERE profile.id IN (p_actor_id, p_target_id)
  ORDER BY profile.id
  FOR UPDATE;

  SELECT profile.*
  INTO v_actor_profile
  FROM public.user_profiles AS profile
  WHERE profile.id = p_actor_id;
  v_actor_profile_found := FOUND;

  IF NOT v_actor_profile_found
    OR v_actor_profile.deleted_at IS NOT NULL
    OR v_actor_profile.banned_at IS NOT NULL
    OR (
      COALESCE(v_actor_profile.is_banned, false)
      AND (
        v_actor_profile.ban_expires_at IS NULL
        OR v_actor_profile.ban_expires_at > pg_catalog.clock_timestamp()
      )
    )
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'account_inactive');
  END IF;

  SELECT profile.*
  INTO v_target_profile
  FROM public.user_profiles AS profile
  WHERE profile.id = p_target_id;
  v_target_profile_found := FOUND;

  IF p_action IN ('ban', 'kick') AND NOT v_target_profile_found THEN
    RETURN pg_catalog.jsonb_build_object('status', 'target_not_found');
  END IF;

  SELECT target_group.*
  INTO v_group
  FROM public.groups AS target_group
  WHERE target_group.id = p_group_id
  FOR UPDATE;
  v_group_found := FOUND;

  IF NOT v_group_found THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;
  IF v_group.dissolved_at IS NOT NULL THEN
    RETURN pg_catalog.jsonb_build_object('status', 'dissolved');
  END IF;

  SELECT member.role::text
  INTO v_actor_role
  FROM public.group_members AS member
  WHERE member.group_id = p_group_id
    AND member.user_id = p_actor_id
  FOR UPDATE;
  v_actor_is_member := FOUND;

  IF NOT v_actor_is_member OR v_actor_role NOT IN ('owner', 'admin') THEN
    RETURN pg_catalog.jsonb_build_object('status', 'forbidden');
  END IF;

  SELECT member.role::text
  INTO v_target_role
  FROM public.group_members AS member
  WHERE member.group_id = p_group_id
    AND member.user_id = p_target_id
  FOR UPDATE;
  v_target_is_member := FOUND;

  PERFORM 1
  FROM public.group_bans AS ban
  WHERE ban.group_id = p_group_id
    AND ban.user_id = p_target_id
  FOR UPDATE;
  v_target_is_banned := FOUND;

  IF p_action = 'unban' THEN
    IF NOT v_target_is_banned THEN
      RETURN pg_catalog.jsonb_build_object('status', 'already_unbanned');
    END IF;

    DELETE FROM public.group_bans AS ban
    WHERE ban.group_id = p_group_id
      AND ban.user_id = p_target_id;
    GET DIAGNOSTICS v_affected_count = ROW_COUNT;
    IF v_affected_count <> 1 THEN
      RAISE EXCEPTION 'atomic group unban deleted % rows', v_affected_count;
    END IF;

    INSERT INTO public.group_audit_log (
      group_id, actor_id, action, target_id, details
    ) VALUES (
      p_group_id, p_actor_id, 'unban', p_target_id, '{}'::jsonb
    );

    RETURN pg_catalog.jsonb_build_object('status', 'unbanned');
  END IF;

  IF p_target_id = v_group.created_by OR v_target_role = 'owner' THEN
    RETURN pg_catalog.jsonb_build_object('status', 'owner_forbidden');
  END IF;
  IF v_actor_role = 'admin' AND v_target_role = 'admin' THEN
    RETURN pg_catalog.jsonb_build_object('status', 'hierarchy_forbidden');
  END IF;

  IF p_action = 'kick' THEN
    IF NOT v_target_is_member THEN
      RETURN pg_catalog.jsonb_build_object('status', 'not_member');
    END IF;

    DELETE FROM public.group_members AS member
    WHERE member.group_id = p_group_id
      AND member.user_id = p_target_id;
    GET DIAGNOSTICS v_affected_count = ROW_COUNT;
    IF v_affected_count <> 1 THEN
      RAISE EXCEPTION 'atomic group kick deleted % rows', v_affected_count;
    END IF;

    INSERT INTO public.group_audit_log (
      group_id, actor_id, action, target_id, details
    ) VALUES (
      p_group_id,
      p_actor_id,
      'kick',
      p_target_id,
      pg_catalog.jsonb_build_object('reason', v_reason)
    );

    SELECT target_group.member_count
    INTO v_member_count
    FROM public.groups AS target_group
    WHERE target_group.id = p_group_id;

    RETURN pg_catalog.jsonb_build_object(
      'status', 'kicked',
      'member_count', v_member_count
    );
  END IF;

  IF v_target_is_banned AND NOT v_target_is_member THEN
    RETURN pg_catalog.jsonb_build_object('status', 'already_banned');
  END IF;

  IF v_target_is_member THEN
    DELETE FROM public.group_members AS member
    WHERE member.group_id = p_group_id
      AND member.user_id = p_target_id;
    GET DIAGNOSTICS v_affected_count = ROW_COUNT;
    IF v_affected_count <> 1 THEN
      RAISE EXCEPTION 'atomic group ban deleted % rows', v_affected_count;
    END IF;
  END IF;

  IF NOT v_target_is_banned THEN
    INSERT INTO public.group_bans (
      group_id, user_id, banned_by, reason
    ) VALUES (
      p_group_id, p_target_id, p_actor_id, v_reason
    );
  END IF;

  INSERT INTO public.group_audit_log (
    group_id, actor_id, action, target_id, details
  ) VALUES (
    p_group_id,
    p_actor_id,
    'ban',
    p_target_id,
    pg_catalog.jsonb_build_object('reason', v_reason)
  );

  SELECT target_group.member_count
  INTO v_member_count
  FROM public.groups AS target_group
  WHERE target_group.id = p_group_id;

  RETURN pg_catalog.jsonb_build_object(
    'status', 'banned',
    'member_removed', v_target_is_member,
    'member_count', v_member_count
  );
END
$function$;

ALTER FUNCTION public.moderate_group_member_atomic(
  uuid, uuid, uuid, text, text
) OWNER TO postgres;

DO $converge_function_acls$
DECLARE
  signature pg_catalog.regprocedure;
  function_owner oid;
  grantee_info record;
BEGIN
  FOREACH signature IN ARRAY ARRAY[
    'public.reject_banned_group_membership()'::pg_catalog.regprocedure,
    'public.reject_member_group_ban()'::pg_catalog.regprocedure,
    'public.moderate_group_member_atomic(uuid,uuid,uuid,text,text)'::pg_catalog.regprocedure
  ]
  LOOP
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

    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON FUNCTION %s '
        || 'FROM PUBLIC, anon, authenticated, service_role',
      signature
    );
  END LOOP;
END
$converge_function_acls$;

GRANT EXECUTE ON FUNCTION public.moderate_group_member_atomic(
  uuid, uuid, uuid, text, text
) TO service_role;

DO $postflight$
DECLARE
  moderation_rpc pg_catalog.regprocedure :=
    'public.moderate_group_member_atomic(uuid,uuid,uuid,text,text)'::pg_catalog.regprocedure;
  helper_signature pg_catalog.regprocedure;
  authenticated_oid oid := (
    SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'authenticated'
  );
  service_oid oid := (
    SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'service_role'
  );
  postgres_oid oid := (
    SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'postgres'
  );
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.group_members AS member
    JOIN public.group_bans AS ban
      ON ban.group_id = member.group_id
     AND ban.user_id = member.user_id
  ) THEN
    RAISE EXCEPTION 'banned membership invariant is not exact';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_info
    WHERE trigger_info.tgrelid = 'public.group_members'::pg_catalog.regclass
      AND trigger_info.tgname = 'trg_group_members_10_reject_ban'
      AND trigger_info.tgfoid =
        'public.reject_banned_group_membership()'::pg_catalog.regprocedure
      AND trigger_info.tgenabled = 'O'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_info
    WHERE trigger_info.tgrelid = 'public.group_bans'::pg_catalog.regclass
      AND trigger_info.tgname = 'trg_group_bans_10_reject_member'
      AND trigger_info.tgfoid =
        'public.reject_member_group_ban()'::pg_catalog.regprocedure
      AND trigger_info.tgenabled = 'O'
  ) THEN
    RAISE EXCEPTION 'ban/member exclusion triggers are missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_info
    WHERE function_info.oid = moderation_rpc
      AND function_info.prosecdef
      AND pg_catalog.pg_get_userbyid(function_info.proowner) = 'postgres'
      AND function_info.proconfig = ARRAY['search_path=pg_catalog, public']::text[]
  ) OR NOT pg_catalog.has_function_privilege(
    'service_role', moderation_rpc, 'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'anon', moderation_rpc, 'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'authenticated', moderation_rpc, 'EXECUTE'
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_info
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        function_info.proacl,
        pg_catalog.acldefault('f', function_info.proowner)
      )
    ) AS acl
    WHERE function_info.oid = moderation_rpc
      AND acl.privilege_type = 'EXECUTE'
      AND acl.grantee NOT IN (function_info.proowner, service_oid)
  ) THEN
    RAISE EXCEPTION 'atomic moderation RPC ACL/security contract drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_info
    WHERE function_info.pronamespace = 'public'::pg_catalog.regnamespace
      AND function_info.proname = 'moderate_group_member_atomic'
      AND function_info.oid <> moderation_rpc
  ) THEN
    RAISE EXCEPTION 'unexpected atomic moderation overload remains';
  END IF;

  FOREACH helper_signature IN ARRAY ARRAY[
    'public.reject_banned_group_membership()'::pg_catalog.regprocedure,
    'public.reject_member_group_ban()'::pg_catalog.regprocedure
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS function_info
      WHERE function_info.oid = helper_signature
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
      WHERE function_info.oid = helper_signature
        AND acl.privilege_type = 'EXECUTE'
        AND acl.grantee <> function_info.proowner
    ) THEN
      RAISE EXCEPTION 'moderation trigger helper security contract drifted: %',
        helper_signature;
    END IF;
  END LOOP;

  IF NOT pg_catalog.has_table_privilege(
    'authenticated', 'public.group_bans', 'SELECT'
  ) OR pg_catalog.has_table_privilege(
    'authenticated', 'public.group_bans',
    'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
  ) OR NOT pg_catalog.has_table_privilege(
    'service_role', 'public.group_bans', 'SELECT'
  ) OR pg_catalog.has_table_privilege(
    'service_role', 'public.group_bans',
    'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
  ) OR pg_catalog.has_table_privilege(
    'anon', 'public.group_bans',
    'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
  ) THEN
    RAISE EXCEPTION 'group_bans effective ACL drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        relation.relacl,
        pg_catalog.acldefault('r', relation.relowner)
      )
    ) AS acl
    WHERE relation.oid = 'public.group_bans'::pg_catalog.regclass
      AND (
        acl.grantee NOT IN (relation.relowner, authenticated_oid, service_oid)
        OR (
          acl.grantee IN (authenticated_oid, service_oid)
          AND acl.privilege_type <> 'SELECT'
        )
        OR acl.is_grantable
      )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl
    WHERE attribute.attrelid = 'public.group_bans'::pg_catalog.regclass
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND acl.grantee <> postgres_oid
  ) THEN
    RAISE EXCEPTION 'group_bans raw or column ACL drifted';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.group_bans'::pg_catalog.regclass
  ) <> 3 OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.group_bans'::pg_catalog.regclass
      AND policy.polname = 'internal_owner_mutation'
      AND policy.polcmd = '*'
      AND policy.polroles = ARRAY[postgres_oid]::oid[]
      AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid, true) = 'true'
      AND pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid, true) = 'true'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.group_bans'::pg_catalog.regclass
      AND policy.polname = 'server_read'
      AND policy.polcmd = 'r'
      AND policy.polroles = ARRAY[service_oid]::oid[]
      AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid, true) = 'true'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.group_bans'::pg_catalog.regclass
      AND policy.polname = 'browser_admin_read'
      AND policy.polcmd = 'r'
      AND policy.polroles = ARRAY[authenticated_oid]::oid[]
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = 'public.group_bans'::pg_catalog.regclass
      AND relation.relrowsecurity
      AND relation.relforcerowsecurity
  ) THEN
    RAISE EXCEPTION 'group_bans policy/RLS boundary drifted';
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
    RAISE EXCEPTION 'member count drifted during moderation installation';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
