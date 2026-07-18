-- Remove group membership/ban edges before the Auth parent row is deleted.
--
-- Auth cascades delete these rows parent-first. Their serialization triggers
-- acquire the membership advisory lock, while every canonical group mutation
-- acquires that advisory lock before locking user_profiles. Pre-purging under
-- the canonical edge -> profile -> group order removes that lock inversion.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '90s';

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('group-application-authority-migrations', 0)
);

DO $preflight$
DECLARE
  required_role text;
  relation_name text;
  relation_oid pg_catalog.regclass;
  user_id_attnum smallint;
  auth_user_id_attnum smallint;
  user_fk_count integer;
  canonical_user_fk_count integer;
  group_members_user_fk_state text;
BEGIN
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

  FOREACH relation_name IN ARRAY ARRAY[
    'user_profiles',
    'groups',
    'group_members',
    'group_bans'
  ]::text[]
  LOOP
    relation_oid := pg_catalog.to_regclass('public.' || relation_name);
    IF relation_oid IS NULL OR NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS relation
      WHERE relation.oid = relation_oid
        AND relation.relkind IN ('r', 'p')
        AND pg_catalog.pg_get_userbyid(relation.relowner) = 'postgres'
    ) THEN
      RAISE EXCEPTION 'postgres-owned account purge relation is missing: public.%',
        relation_name;
    END IF;
  END LOOP;

  IF pg_catalog.to_regclass('auth.users') IS NULL OR EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('user_profiles', 'id', 'uuid'::pg_catalog.regtype, true),
        ('user_profiles', 'deleted_at', 'timestamptz'::pg_catalog.regtype, false),
        ('user_profiles', 'deletion_scheduled_at', 'timestamptz'::pg_catalog.regtype, false),
        ('groups', 'id', 'uuid'::pg_catalog.regtype, true),
        ('groups', 'member_count', 'integer'::pg_catalog.regtype, true),
        ('group_members', 'group_id', 'uuid'::pg_catalog.regtype, true),
        ('group_members', 'user_id', 'uuid'::pg_catalog.regtype, true),
        ('group_members', 'role', 'public.member_role'::pg_catalog.regtype, true),
        ('group_bans', 'group_id', 'uuid'::pg_catalog.regtype, true),
        ('group_bans', 'user_id', 'uuid'::pg_catalog.regtype, true)
    ) AS required_column(
      relation_name,
      column_name,
      type_oid,
      must_be_not_null
    )
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
        AND (
          NOT required_column.must_be_not_null
          OR attribute.attnotnull
        )
    )
  ) THEN
    RAISE EXCEPTION 'deleted-account group purge columns are incompatible';
  END IF;

  SELECT attribute.attnum
  INTO auth_user_id_attnum
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'auth.users'::pg_catalog.regclass
    AND attribute.attname = 'id'
    AND attribute.atttypid = 'uuid'::pg_catalog.regtype
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped
    AND attribute.attnotnull;
  IF auth_user_id_attnum IS NULL THEN
    RAISE EXCEPTION 'auth.users id contract is incompatible';
  END IF;

  -- The Auth deletion proof depends on exactly one immediate CASCADE edge for
  -- each personal group relation. Extra same-column FKs can silently restore a
  -- RESTRICT blocker even when the canonical FK is also present.
  FOREACH relation_name IN ARRAY ARRAY[
    'user_profiles',
    'group_bans'
  ]::text[]
  LOOP
    relation_oid := ('public.' || relation_name)::pg_catalog.regclass;
    SELECT attribute.attnum
    INTO user_id_attnum
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = relation_oid
      AND attribute.attname = CASE
        WHEN relation_name = 'user_profiles' THEN 'id'
        ELSE 'user_id'
      END
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped;

    IF (
      SELECT pg_catalog.count(*)
      FROM pg_catalog.pg_constraint AS constraint_info
      WHERE constraint_info.conrelid = relation_oid
        AND constraint_info.contype = 'f'
        AND constraint_info.conkey = ARRAY[user_id_attnum]::smallint[]
    ) <> 1 OR NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_constraint AS constraint_info
      WHERE constraint_info.conrelid = relation_oid
        AND constraint_info.contype = 'f'
        AND constraint_info.conkey = ARRAY[user_id_attnum]::smallint[]
        AND constraint_info.confrelid = 'auth.users'::pg_catalog.regclass
        AND constraint_info.confkey = ARRAY[auth_user_id_attnum]::smallint[]
        AND constraint_info.confmatchtype = 's'
        AND constraint_info.confupdtype = 'a'
        AND constraint_info.confdeltype = 'c'
        AND constraint_info.convalidated
        AND NOT constraint_info.condeferrable
        AND NOT constraint_info.condeferred
    ) THEN
      RAISE EXCEPTION 'account purge CASCADE FK is incompatible: public.%',
        relation_name;
    END IF;
  END LOOP;

  -- Production can predate the group_members -> auth.users edge entirely.
  -- Repair only that exact absence. Any existing FK involving user_id must be
  -- the single named, immediate, validated CASCADE contract; a differently
  -- shaped, differently named, composite, or duplicate edge fails closed.
  relation_oid := 'public.group_members'::pg_catalog.regclass;
  SELECT attribute.attnum
  INTO STRICT user_id_attnum
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = relation_oid
    AND attribute.attname = 'user_id'
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;

  SELECT
    pg_catalog.count(*)::integer,
    pg_catalog.count(*) FILTER (
      WHERE constraint_info.conname = 'group_members_user_id_fkey'
        AND constraint_info.conkey = ARRAY[user_id_attnum]::smallint[]
        AND constraint_info.confrelid = 'auth.users'::pg_catalog.regclass
        AND constraint_info.confkey =
          ARRAY[auth_user_id_attnum]::smallint[]
        AND constraint_info.confmatchtype = 's'
        AND constraint_info.confupdtype = 'a'
        AND constraint_info.confdeltype = 'c'
        AND constraint_info.convalidated
        AND NOT constraint_info.condeferrable
        AND NOT constraint_info.condeferred
    )::integer
  INTO user_fk_count, canonical_user_fk_count
  FROM pg_catalog.pg_constraint AS constraint_info
  WHERE constraint_info.conrelid = relation_oid
    AND constraint_info.contype = 'f'
    AND user_id_attnum = ANY (constraint_info.conkey);

  IF user_fk_count = 0 THEN
    IF EXISTS (
      SELECT 1
      FROM pg_catalog.pg_constraint AS constraint_info
      WHERE constraint_info.conrelid = relation_oid
        AND constraint_info.conname = 'group_members_user_id_fkey'
    ) THEN
      RAISE EXCEPTION
        'account purge CASCADE FK name is occupied: public.group_members';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM public.group_members AS member
      WHERE NOT EXISTS (
        SELECT 1
        FROM auth.users AS auth_user
        WHERE auth_user.id = member.user_id
      )
    ) THEN
      RAISE EXCEPTION
        'group_members user_id FK is missing and orphan rows exist';
    END IF;
    group_members_user_fk_state := 'missing';
  ELSIF user_fk_count = 1 AND canonical_user_fk_count = 1 THEN
    group_members_user_fk_state := 'canonical';
  ELSE
    RAISE EXCEPTION
      'account purge CASCADE FK is incompatible: public.group_members';
  END IF;

  PERFORM pg_catalog.set_config(
    'app.group_members_user_fk_state',
    group_members_user_fk_state,
    true
  );

  IF pg_catalog.to_regprocedure(
    'public.sync_group_member_count()'
  ) IS NULL OR pg_catalog.to_regprocedure(
    'public.serialize_group_membership_edge()'
  ) IS NULL OR pg_catalog.to_regprocedure(
    'public.mutate_group_membership_atomic(uuid,uuid,text,boolean)'
  ) IS NULL OR pg_catalog.to_regprocedure(
    'public.moderate_group_member_atomic(uuid,uuid,uuid,text,text)'
  ) IS NULL OR pg_catalog.to_regprocedure(
    'public.reject_group_membership_identity_update()'
  ) IS NULL THEN
    RAISE EXCEPTION 'atomic group membership/moderation migrations must be applied first';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_info
    WHERE trigger_info.tgrelid = 'public.group_members'::pg_catalog.regclass
      AND trigger_info.tgname = 'trg_sync_group_member_count'
      AND trigger_info.tgfoid =
        'public.sync_group_member_count()'::pg_catalog.regprocedure
      AND trigger_info.tgenabled = 'O'
      AND NOT trigger_info.tgisinternal
      AND trigger_info.tgtype = 13
      AND trigger_info.tgattr = ''::pg_catalog.int2vector
      AND trigger_info.tgqual IS NULL
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_info
    WHERE trigger_info.tgrelid = 'public.group_members'::pg_catalog.regclass
      AND trigger_info.tgname = 'trg_group_members_05_serialize_edge'
      AND trigger_info.tgfoid =
        'public.serialize_group_membership_edge()'::pg_catalog.regprocedure
      AND trigger_info.tgenabled = 'O'
      AND NOT trigger_info.tgisinternal
      AND trigger_info.tgtype = 31
      AND trigger_info.tgqual IS NULL
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_info
    WHERE trigger_info.tgrelid = 'public.group_bans'::pg_catalog.regclass
      AND trigger_info.tgname = 'trg_group_bans_05_serialize_edge'
      AND trigger_info.tgfoid =
        'public.serialize_group_membership_edge()'::pg_catalog.regprocedure
      AND trigger_info.tgenabled = 'O'
      AND NOT trigger_info.tgisinternal
      AND trigger_info.tgtype = 31
      AND trigger_info.tgqual IS NULL
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_info
    WHERE trigger_info.tgrelid = 'public.group_members'::pg_catalog.regclass
      AND trigger_info.tgname = 'trg_group_members_99_identity_immutable'
      AND trigger_info.tgfoid =
        'public.reject_group_membership_identity_update()'::pg_catalog.regprocedure
      AND trigger_info.tgenabled = 'O'
      AND NOT trigger_info.tgisinternal
      AND trigger_info.tgtype = 17
      AND trigger_info.tgattr = ''::pg_catalog.int2vector
      AND trigger_info.tgqual IS NULL
  ) THEN
    RAISE EXCEPTION 'canonical group edge trigger contract drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_info
    WHERE function_info.pronamespace = 'public'::pg_catalog.regnamespace
      AND function_info.proname IN (
        'reject_inactive_group_edge',
        'purge_deleted_account_group_edges'
      )
      AND (
        (function_info.proname = 'reject_inactive_group_edge'
          AND pg_catalog.pg_get_function_identity_arguments(function_info.oid) <> '')
        OR (function_info.proname = 'purge_deleted_account_group_edges'
          AND pg_catalog.pg_get_function_identity_arguments(function_info.oid) <> 'p_user_id uuid')
      )
  ) THEN
    RAISE EXCEPTION 'unexpected deleted-account group purge overload exists';
  END IF;

  IF pg_catalog.to_regprocedure('public.reject_inactive_group_edge()') IS NOT NULL
    AND (
      SELECT function_info.prorettype
      FROM pg_catalog.pg_proc AS function_info
      WHERE function_info.oid = pg_catalog.to_regprocedure(
        'public.reject_inactive_group_edge()'
      )
    ) <> 'trigger'::pg_catalog.regtype
  THEN
    RAISE EXCEPTION 'inactive group edge guard has an incompatible return type';
  END IF;

  IF pg_catalog.to_regprocedure(
    'public.purge_deleted_account_group_edges(uuid)'
  ) IS NOT NULL AND (
    SELECT function_info.prorettype
    FROM pg_catalog.pg_proc AS function_info
    WHERE function_info.oid = pg_catalog.to_regprocedure(
      'public.purge_deleted_account_group_edges(uuid)'
    )
  ) <> 'jsonb'::pg_catalog.regtype
  THEN
    RAISE EXCEPTION 'deleted-account group purge has an incompatible return type';
  END IF;
END
$preflight$;

-- Close the trigger installation gap. The edge tables are locked before any
-- profile table lock, matching the runtime edge-first discipline.
LOCK TABLE public.group_members, public.group_bans IN ACCESS EXCLUSIVE MODE;

DO $converge_group_members_user_fk$
DECLARE
  expected_state text := pg_catalog.current_setting(
    'app.group_members_user_fk_state'
  );
  user_id_attnum smallint;
  auth_user_id_attnum smallint;
  user_fk_count integer;
  canonical_user_fk_count integer;
BEGIN
  SELECT attribute.attnum
  INTO STRICT user_id_attnum
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.group_members'::pg_catalog.regclass
    AND attribute.attname = 'user_id'
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;
  SELECT attribute.attnum
  INTO STRICT auth_user_id_attnum
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'auth.users'::pg_catalog.regclass
    AND attribute.attname = 'id'
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;

  SELECT
    pg_catalog.count(*)::integer,
    pg_catalog.count(*) FILTER (
      WHERE constraint_info.conname = 'group_members_user_id_fkey'
        AND constraint_info.conkey = ARRAY[user_id_attnum]::smallint[]
        AND constraint_info.confrelid = 'auth.users'::pg_catalog.regclass
        AND constraint_info.confkey =
          ARRAY[auth_user_id_attnum]::smallint[]
        AND constraint_info.confmatchtype = 's'
        AND constraint_info.confupdtype = 'a'
        AND constraint_info.confdeltype = 'c'
        AND constraint_info.convalidated
        AND NOT constraint_info.condeferrable
        AND NOT constraint_info.condeferred
    )::integer
  INTO user_fk_count, canonical_user_fk_count
  FROM pg_catalog.pg_constraint AS constraint_info
  WHERE constraint_info.conrelid =
      'public.group_members'::pg_catalog.regclass
    AND constraint_info.contype = 'f'
    AND user_id_attnum = ANY (constraint_info.conkey);

  IF expected_state = 'missing' THEN
    IF user_fk_count <> 0 OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_constraint AS constraint_info
      WHERE constraint_info.conrelid =
          'public.group_members'::pg_catalog.regclass
        AND constraint_info.conname = 'group_members_user_id_fkey'
    ) THEN
      RAISE EXCEPTION
        'group_members user_id FK changed while acquiring the edge lock';
    END IF;

    -- Do not use NOT VALID: PostgreSQL validates every existing member while
    -- holding the required table locks. An orphan committed after preflight
    -- therefore aborts this transaction instead of being grandfathered in.
    ALTER TABLE public.group_members
      ADD CONSTRAINT group_members_user_id_fkey
      FOREIGN KEY (user_id)
      REFERENCES auth.users(id)
      MATCH SIMPLE
      ON UPDATE NO ACTION
      ON DELETE CASCADE
      NOT DEFERRABLE;
  ELSIF expected_state = 'canonical' THEN
    IF user_fk_count <> 1 OR canonical_user_fk_count <> 1 THEN
      RAISE EXCEPTION
        'group_members user_id FK changed while acquiring the edge lock';
    END IF;
  ELSE
    RAISE EXCEPTION 'group_members user_id FK preflight state is invalid';
  END IF;
END
$converge_group_members_user_fk$;

CREATE OR REPLACE FUNCTION public.reject_inactive_group_edge()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_profile_active boolean := false;
BEGIN
  SELECT profile.deleted_at IS NULL
  INTO v_profile_active
  FROM public.user_profiles AS profile
  WHERE profile.id = NEW.user_id
  FOR KEY SHARE;

  IF NOT FOUND OR NOT v_profile_active THEN
    RAISE EXCEPTION 'inactive account cannot create a group membership edge'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$function$;

ALTER FUNCTION public.reject_inactive_group_edge() OWNER TO postgres;

DROP TRIGGER IF EXISTS trg_group_members_08_reject_inactive_account
  ON public.group_members;
CREATE TRIGGER trg_group_members_08_reject_inactive_account
  BEFORE INSERT OR UPDATE OF group_id, user_id ON public.group_members
  FOR EACH ROW
  EXECUTE FUNCTION public.reject_inactive_group_edge();

DROP TRIGGER IF EXISTS trg_group_bans_08_reject_inactive_account
  ON public.group_bans;
CREATE TRIGGER trg_group_bans_08_reject_inactive_account
  BEFORE INSERT OR UPDATE OF group_id, user_id ON public.group_bans
  FOR EACH ROW
  EXECUTE FUNCTION public.reject_inactive_group_edge();

CREATE OR REPLACE FUNCTION public.purge_deleted_account_group_edges(
  p_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_profile public.user_profiles%ROWTYPE;
  v_group_ids uuid[] := ARRAY[]::uuid[];
  v_group_id uuid;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_memberships_removed integer := 0;
  v_bans_removed integer := 0;
  v_owner_memberships_removed integer := 0;
  v_affected integer := 0;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;

  -- Lock every currently committed edge before the profile. A canonical join
  -- or moderation transaction that is already in flight either commits before
  -- this loop and is included, or waits on the profile and is rejected by the
  -- inactive-edge guard after this purge commits.
  SELECT COALESCE(
    pg_catalog.array_agg(edge.group_id ORDER BY edge.group_id),
    ARRAY[]::uuid[]
  )
  INTO v_group_ids
  FROM (
    SELECT member.group_id
    FROM public.group_members AS member
    WHERE member.user_id = p_user_id
    UNION
    SELECT ban.group_id
    FROM public.group_bans AS ban
    WHERE ban.user_id = p_user_id
  ) AS edge;

  FOREACH v_group_id IN ARRAY v_group_ids
  LOOP
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'group-membership:' || v_group_id::text || ':' || p_user_id::text,
        0
      )
    );
  END LOOP;

  SELECT profile.*
  INTO v_profile
  FROM public.user_profiles AS profile
  WHERE profile.id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;
  IF v_profile.deleted_at IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('status', 'account_active');
  END IF;
  IF v_profile.deletion_scheduled_at IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_scheduled');
  END IF;
  IF v_profile.deletion_scheduled_at > v_now THEN
    RETURN pg_catalog.jsonb_build_object('status', 'grace_period_active');
  END IF;

  -- Re-read after taking the profile lock. This includes an edge committed by
  -- a writer that held the profile before the purge. An uncommitted writer now
  -- waiting on the profile is invisible here and will fail the inactive guard.
  SELECT COALESCE(
    pg_catalog.array_agg(edge.group_id ORDER BY edge.group_id),
    ARRAY[]::uuid[]
  )
  INTO v_group_ids
  FROM (
    SELECT member.group_id
    FROM public.group_members AS member
    WHERE member.user_id = p_user_id
    UNION
    SELECT ban.group_id
    FROM public.group_bans AS ban
    WHERE ban.user_id = p_user_id
  ) AS edge;

  FOREACH v_group_id IN ARRAY v_group_ids
  LOOP
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'group-membership:' || v_group_id::text || ':' || p_user_id::text,
        0
      )
    );
  END LOOP;

  -- Group row locks are acquired in UUID order after all edge/profile locks.
  -- This matches join/moderation and makes multiple account purges deterministic.
  PERFORM target_group.id
  FROM public.groups AS target_group
  WHERE target_group.id = ANY(v_group_ids)
  ORDER BY target_group.id
  FOR UPDATE;

  FOREACH v_group_id IN ARRAY v_group_ids
  LOOP
    DELETE FROM public.group_bans AS ban
    WHERE ban.group_id = v_group_id
      AND ban.user_id = p_user_id;
    GET DIAGNOSTICS v_affected = ROW_COUNT;
    v_bans_removed := v_bans_removed + v_affected;

    SELECT pg_catalog.count(*)::integer
    INTO v_affected
    FROM public.group_members AS member
    WHERE member.group_id = v_group_id
      AND member.user_id = p_user_id
      AND member.role = 'owner'::public.member_role;
    v_owner_memberships_removed := v_owner_memberships_removed + v_affected;

    DELETE FROM public.group_members AS member
    WHERE member.group_id = v_group_id
      AND member.user_id = p_user_id;
    GET DIAGNOSTICS v_affected = ROW_COUNT;
    v_memberships_removed := v_memberships_removed + v_affected;

    -- The canonical trigger updates the cache. Reconcile from source while the
    -- group row is locked as a final fail-safe against historical cache drift.
    UPDATE public.groups AS target_group
    SET member_count = (
      SELECT pg_catalog.count(*)::integer
      FROM public.group_members AS remaining_member
      WHERE remaining_member.group_id = v_group_id
    )
    WHERE target_group.id = v_group_id
      AND target_group.member_count IS DISTINCT FROM (
        SELECT pg_catalog.count(*)::integer
        FROM public.group_members AS remaining_member
        WHERE remaining_member.group_id = v_group_id
      );
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM public.group_members AS member
    WHERE member.user_id = p_user_id
  ) OR EXISTS (
    SELECT 1
    FROM public.group_bans AS ban
    WHERE ban.user_id = p_user_id
  ) THEN
    RAISE EXCEPTION 'deleted-account group edge purge left residual authority';
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'status', 'purged',
    'memberships_removed', v_memberships_removed,
    'bans_removed', v_bans_removed,
    'owner_memberships_removed', v_owner_memberships_removed
  );
END
$function$;

ALTER FUNCTION public.purge_deleted_account_group_edges(uuid)
  OWNER TO postgres;

DO $converge_function_acls$
DECLARE
  signature pg_catalog.regprocedure;
  function_owner oid;
  grantee_info record;
BEGIN
  FOREACH signature IN ARRAY ARRAY[
    'public.reject_inactive_group_edge()'::pg_catalog.regprocedure,
    'public.purge_deleted_account_group_edges(uuid)'::pg_catalog.regprocedure
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
  END LOOP;

  REVOKE ALL ON FUNCTION public.reject_inactive_group_edge()
    FROM PUBLIC, anon, authenticated, service_role;
  REVOKE ALL ON FUNCTION public.purge_deleted_account_group_edges(uuid)
    FROM PUBLIC, anon, authenticated, service_role;
  GRANT EXECUTE ON FUNCTION public.purge_deleted_account_group_edges(uuid)
    TO service_role;
END
$converge_function_acls$;

DO $postflight$
DECLARE
  guard_signature pg_catalog.regprocedure :=
    'public.reject_inactive_group_edge()'::pg_catalog.regprocedure;
  purge_signature pg_catalog.regprocedure :=
    'public.purge_deleted_account_group_edges(uuid)'::pg_catalog.regprocedure;
  service_role_oid oid := (
    SELECT role_info.oid
    FROM pg_catalog.pg_roles AS role_info
    WHERE role_info.rolname = 'service_role'
  );
  group_member_user_id_attnum smallint;
  auth_user_id_attnum smallint;
BEGIN
  SELECT attribute.attnum
  INTO STRICT group_member_user_id_attnum
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.group_members'::pg_catalog.regclass
    AND attribute.attname = 'user_id'
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;
  SELECT attribute.attnum
  INTO STRICT auth_user_id_attnum
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'auth.users'::pg_catalog.regclass
    AND attribute.attname = 'id'
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_constraint AS constraint_info
    WHERE constraint_info.conrelid =
        'public.group_members'::pg_catalog.regclass
      AND constraint_info.contype = 'f'
      AND group_member_user_id_attnum = ANY (constraint_info.conkey)
  ) <> 1 OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_info
    WHERE constraint_info.conrelid =
        'public.group_members'::pg_catalog.regclass
      AND constraint_info.conname = 'group_members_user_id_fkey'
      AND constraint_info.contype = 'f'
      AND constraint_info.conkey =
        ARRAY[group_member_user_id_attnum]::smallint[]
      AND constraint_info.confrelid = 'auth.users'::pg_catalog.regclass
      AND constraint_info.confkey = ARRAY[auth_user_id_attnum]::smallint[]
      AND constraint_info.confmatchtype = 's'
      AND constraint_info.confupdtype = 'a'
      AND constraint_info.confdeltype = 'c'
      AND constraint_info.convalidated
      AND NOT constraint_info.condeferrable
      AND NOT constraint_info.condeferred
  ) THEN
    RAISE EXCEPTION
      'group_members user_id CASCADE FK postflight is incompatible';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_info
    WHERE function_info.pronamespace = 'public'::pg_catalog.regnamespace
      AND function_info.proname IN (
        'reject_inactive_group_edge',
        'purge_deleted_account_group_edges'
      )
      AND function_info.oid NOT IN (guard_signature, purge_signature)
  ) THEN
    RAISE EXCEPTION 'unexpected deleted-account group purge overload remains';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_info
    WHERE function_info.oid = guard_signature
      AND function_info.prorettype = 'trigger'::pg_catalog.regtype
      AND function_info.prosecdef
      AND function_info.provolatile = 'v'
      AND function_info.proparallel = 'u'
      AND function_info.prokind = 'f'
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
    RAISE EXCEPTION 'inactive group edge guard security contract drifted';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_info
    WHERE function_info.oid = purge_signature
      AND function_info.prorettype = 'jsonb'::pg_catalog.regtype
      AND function_info.prosecdef
      AND function_info.provolatile = 'v'
      AND function_info.proparallel = 'u'
      AND function_info.prokind = 'f'
      AND function_info.pronargs = 1
      AND pg_catalog.pg_get_userbyid(function_info.proowner) = 'postgres'
      AND function_info.proconfig =
        ARRAY['search_path=pg_catalog, public']::text[]
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_info
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        function_info.proacl,
        pg_catalog.acldefault('f', function_info.proowner)
      )
    ) AS acl
    WHERE function_info.oid = purge_signature
      AND acl.privilege_type = 'EXECUTE'
      AND acl.grantee = service_role_oid
      AND NOT acl.is_grantable
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_info
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        function_info.proacl,
        pg_catalog.acldefault('f', function_info.proowner)
      )
    ) AS acl
    WHERE function_info.oid = purge_signature
      AND acl.privilege_type = 'EXECUTE'
      AND acl.grantee NOT IN (function_info.proowner, service_role_oid)
  ) THEN
    RAISE EXCEPTION 'deleted-account group purge ACL/security contract drifted';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_info
    WHERE trigger_info.tgrelid = 'public.group_members'::pg_catalog.regclass
      AND trigger_info.tgname = 'trg_group_members_08_reject_inactive_account'
      AND trigger_info.tgfoid = guard_signature
      AND trigger_info.tgenabled = 'O'
      AND NOT trigger_info.tgisinternal
      AND trigger_info.tgtype = 23
      AND trigger_info.tgqual IS NULL
      AND (
        SELECT pg_catalog.count(*)
        FROM pg_catalog.unnest(trigger_info.tgattr::smallint[]) AS trigger_column(attnum)
      ) = 2
      AND NOT EXISTS (
        SELECT 1
        FROM pg_catalog.unnest(trigger_info.tgattr::smallint[]) AS trigger_column(attnum)
        WHERE trigger_column.attnum NOT IN (
          SELECT attribute.attnum
          FROM pg_catalog.pg_attribute AS attribute
          WHERE attribute.attrelid = 'public.group_members'::pg_catalog.regclass
            AND attribute.attname IN ('group_id', 'user_id')
        )
      )
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_info
    WHERE trigger_info.tgrelid = 'public.group_bans'::pg_catalog.regclass
      AND trigger_info.tgname = 'trg_group_bans_08_reject_inactive_account'
      AND trigger_info.tgfoid = guard_signature
      AND trigger_info.tgenabled = 'O'
      AND NOT trigger_info.tgisinternal
      AND trigger_info.tgtype = 23
      AND trigger_info.tgqual IS NULL
      AND (
        SELECT pg_catalog.count(*)
        FROM pg_catalog.unnest(trigger_info.tgattr::smallint[]) AS trigger_column(attnum)
      ) = 2
      AND NOT EXISTS (
        SELECT 1
        FROM pg_catalog.unnest(trigger_info.tgattr::smallint[]) AS trigger_column(attnum)
        WHERE trigger_column.attnum NOT IN (
          SELECT attribute.attnum
          FROM pg_catalog.pg_attribute AS attribute
          WHERE attribute.attrelid = 'public.group_bans'::pg_catalog.regclass
            AND attribute.attname IN ('group_id', 'user_id')
        )
      )
  ) THEN
    RAISE EXCEPTION 'inactive group edge guard trigger contract drifted';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
