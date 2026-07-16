-- Invitation verification is read-only; creation, revocation and redemption
-- are separate service-owned transactions. Revocation preserves evidence.

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
    'group_invites',
    'group_invite_redemptions',
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
      RAISE EXCEPTION 'postgres-owned invitation relation is missing: public.%',
        required_relation;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('groups', 'id'),
        ('groups', 'visibility'),
        ('groups', 'dissolved_at'),
        ('groups', 'is_premium_only'),
        ('groups', 'min_arena_score'),
        ('groups', 'is_verified_only'),
        ('user_profiles', 'id'),
        ('user_profiles', 'deleted_at'),
        ('user_profiles', 'banned_at'),
        ('user_profiles', 'is_banned'),
        ('user_profiles', 'ban_expires_at'),
        ('user_profiles', 'subscription_tier'),
        ('user_profiles', 'reputation_score'),
        ('user_profiles', 'is_verified_trader'),
        ('group_members', 'group_id'),
        ('group_members', 'user_id'),
        ('group_members', 'role'),
        ('group_bans', 'group_id'),
        ('group_bans', 'user_id'),
        ('group_invites', 'id'),
        ('group_invites', 'group_id'),
        ('group_invites', 'created_by'),
        ('group_invites', 'token_hash'),
        ('group_invites', 'max_uses'),
        ('group_invites', 'used_count'),
        ('group_invites', 'expires_at'),
        ('group_invites', 'created_at'),
        ('group_invite_redemptions', 'invite_id'),
        ('group_invite_redemptions', 'group_id'),
        ('group_invite_redemptions', 'user_id'),
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
    RAISE EXCEPTION 'required atomic invitation columns are missing';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('groups', 'id', 'uuid'::pg_catalog.regtype),
        ('groups', 'visibility', 'public.group_visibility'::pg_catalog.regtype),
        ('groups', 'dissolved_at', 'timestamptz'::pg_catalog.regtype),
        ('groups', 'is_premium_only', 'boolean'::pg_catalog.regtype),
        ('groups', 'min_arena_score', 'integer'::pg_catalog.regtype),
        ('groups', 'is_verified_only', 'boolean'::pg_catalog.regtype),
        ('user_profiles', 'id', 'uuid'::pg_catalog.regtype),
        ('user_profiles', 'deleted_at', 'timestamptz'::pg_catalog.regtype),
        ('user_profiles', 'banned_at', 'timestamptz'::pg_catalog.regtype),
        ('user_profiles', 'is_banned', 'boolean'::pg_catalog.regtype),
        ('user_profiles', 'ban_expires_at', 'timestamptz'::pg_catalog.regtype),
        ('user_profiles', 'subscription_tier', 'text'::pg_catalog.regtype),
        ('user_profiles', 'reputation_score', 'integer'::pg_catalog.regtype),
        ('user_profiles', 'is_verified_trader', 'boolean'::pg_catalog.regtype),
        ('group_members', 'group_id', 'uuid'::pg_catalog.regtype),
        ('group_members', 'user_id', 'uuid'::pg_catalog.regtype),
        ('group_members', 'role', 'public.member_role'::pg_catalog.regtype),
        ('group_bans', 'group_id', 'uuid'::pg_catalog.regtype),
        ('group_bans', 'user_id', 'uuid'::pg_catalog.regtype),
        ('group_invites', 'id', 'uuid'::pg_catalog.regtype),
        ('group_invites', 'group_id', 'uuid'::pg_catalog.regtype),
        ('group_invites', 'created_by', 'uuid'::pg_catalog.regtype),
        ('group_invites', 'token_hash', 'text'::pg_catalog.regtype),
        ('group_invites', 'max_uses', 'integer'::pg_catalog.regtype),
        ('group_invites', 'used_count', 'integer'::pg_catalog.regtype),
        ('group_invites', 'expires_at', 'timestamptz'::pg_catalog.regtype),
        ('group_invites', 'created_at', 'timestamptz'::pg_catalog.regtype),
        ('group_invite_redemptions', 'invite_id', 'uuid'::pg_catalog.regtype),
        ('group_invite_redemptions', 'group_id', 'uuid'::pg_catalog.regtype),
        ('group_invite_redemptions', 'user_id', 'uuid'::pg_catalog.regtype),
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
    RAISE EXCEPTION 'atomic invitation column types are incompatible';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = 'public.group_invites'::pg_catalog.regclass
      AND attribute.attname IN ('revoked_at', 'revoked_by')
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND (
        (attribute.attname = 'revoked_at' AND attribute.atttypid <>
          'timestamptz'::pg_catalog.regtype)
        OR (attribute.attname = 'revoked_by' AND attribute.atttypid <>
          'uuid'::pg_catalog.regtype)
      )
  ) THEN
    RAISE EXCEPTION 'group invite revocation columns are incompatible';
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
    'public.redeem_group_invite_atomic(uuid,uuid,text,boolean)'
  ) IS NULL OR pg_catalog.to_regprocedure(
    'public.serialize_group_membership_edge()'
  ) IS NULL OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index AS index_info
    JOIN pg_catalog.pg_attribute AS attribute
      ON attribute.attrelid = index_info.indrelid
     AND attribute.attnum = index_info.indkey[0]
    WHERE index_info.indexrelid =
        'public.group_invites_token_hash_unique'::pg_catalog.regclass
      AND index_info.indrelid = 'public.group_invites'::pg_catalog.regclass
      AND index_info.indisunique
      AND index_info.indisvalid
      AND index_info.indisready
      AND index_info.indnkeyatts = 1
      AND index_info.indnatts = 1
      AND index_info.indpred IS NULL
      AND index_info.indexprs IS NULL
      AND attribute.attname = 'token_hash'
  ) THEN
    RAISE EXCEPTION 'atomic membership migration 20260716113900 must be applied first';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_info
    WHERE function_info.pronamespace = 'public'::pg_catalog.regnamespace
      AND function_info.proname = 'inspect_group_invite_atomic'
      AND pg_catalog.pg_get_function_identity_arguments(function_info.oid)
        <> 'p_actor_id uuid, p_group_id uuid, p_token_hash text, p_pro_free_promo boolean'
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_info
    WHERE function_info.pronamespace = 'public'::pg_catalog.regnamespace
      AND function_info.proname = 'create_group_invite_atomic'
      AND pg_catalog.pg_get_function_identity_arguments(function_info.oid)
        <> 'p_actor_id uuid, p_group_id uuid, p_token_hash text, p_expires_at timestamp with time zone, p_max_uses integer'
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_info
    WHERE function_info.pronamespace = 'public'::pg_catalog.regnamespace
      AND function_info.proname = 'revoke_group_invite_atomic'
      AND pg_catalog.pg_get_function_identity_arguments(function_info.oid)
        <> 'p_actor_id uuid, p_group_id uuid, p_invite_id uuid'
  ) THEN
    RAISE EXCEPTION 'unexpected atomic group invitation overload exists';
  END IF;
END
$preflight$;

LOCK TABLE
  public.groups,
  public.user_profiles,
  public.group_members,
  public.group_bans,
  public.group_invites,
  public.group_invite_redemptions,
  public.group_audit_log
IN ACCESS EXCLUSIVE MODE;

ALTER TABLE public.group_invites
  ADD COLUMN IF NOT EXISTS revoked_at timestamptz,
  ADD COLUMN IF NOT EXISTS revoked_by uuid;

DO $locked_data_preflight$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.group_invites AS invite
    WHERE (invite.revoked_at IS NULL) <> (invite.revoked_by IS NULL)
      OR (
        invite.revoked_at IS NOT NULL
        AND (
          NOT pg_catalog.isfinite(invite.revoked_at)
          OR invite.expires_at > invite.revoked_at
        )
      )
  ) THEN
    RAISE EXCEPTION 'invalid group invite revocation evidence requires explicit review';
  END IF;
END
$locked_data_preflight$;

ALTER TABLE public.group_invites
  DROP CONSTRAINT IF EXISTS group_invites_revocation_valid;
ALTER TABLE public.group_invites
  ADD CONSTRAINT group_invites_revocation_valid
    CHECK (
      (revoked_at IS NULL AND revoked_by IS NULL)
      OR (
        revoked_at IS NOT NULL
        AND revoked_by IS NOT NULL
        AND pg_catalog.isfinite(revoked_at)
        AND expires_at <= revoked_at
      )
    );

ALTER TABLE public.group_invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.group_invites FORCE ROW LEVEL SECURITY;

DO $replace_invite_policies$
DECLARE
  policy_info record;
BEGIN
  FOR policy_info IN
    SELECT policy.polname
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.group_invites'::pg_catalog.regclass
  LOOP
    EXECUTE pg_catalog.format(
      'DROP POLICY %I ON public.group_invites',
      policy_info.polname
    );
  END LOOP;
END
$replace_invite_policies$;

DO $converge_invite_acls$
DECLARE
  relation_oid oid := 'public.group_invites'::pg_catalog.regclass;
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
      EXECUTE 'REVOKE ALL PRIVILEGES ON TABLE public.group_invites FROM PUBLIC';
    ELSIF grantee_info.rolname IS NOT NULL THEN
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON TABLE public.group_invites FROM %I',
        grantee_info.rolname
      );
    END IF;
  END LOOP;

  REVOKE ALL PRIVILEGES ON TABLE public.group_invites
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
          || 'ON TABLE public.group_invites FROM PUBLIC',
        column_list
      );
    ELSIF grantee_info.rolname IS NOT NULL THEN
      EXECUTE pg_catalog.format(
        'REVOKE SELECT (%1$s), INSERT (%1$s), UPDATE (%1$s), REFERENCES (%1$s) '
          || 'ON TABLE public.group_invites FROM %2$I',
        column_list,
        grantee_info.rolname
      );
    END IF;
  END LOOP;
END
$converge_invite_acls$;

GRANT SELECT ON TABLE public.group_invites TO authenticated, service_role;

CREATE POLICY internal_owner_mutation
  ON public.group_invites
  AS PERMISSIVE
  FOR ALL
  TO postgres
  USING (true)
  WITH CHECK (true);

CREATE POLICY browser_creator_or_admin_read
  ON public.group_invites
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (
    created_by = (SELECT auth.uid())
    OR EXISTS (
      SELECT 1
      FROM public.group_members AS administrator
      WHERE administrator.group_id = group_invites.group_id
        AND administrator.user_id = (SELECT auth.uid())
        AND administrator.role IN (
          'owner'::public.member_role,
          'admin'::public.member_role
        )
    )
  );

CREATE POLICY server_read
  ON public.group_invites
  AS PERMISSIVE
  FOR SELECT
  TO service_role
  USING (true);

CREATE OR REPLACE FUNCTION public.inspect_group_invite_atomic(
  p_actor_id uuid,
  p_group_id uuid,
  p_token_hash text,
  p_pro_free_promo boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_invite public.group_invites%ROWTYPE;
  v_profile public.user_profiles%ROWTYPE;
  v_group public.groups%ROWTYPE;
  v_invite_found boolean := false;
  v_profile_found boolean := false;
  v_group_found boolean := false;
  v_was_redeemed boolean := false;
  v_is_member boolean := false;
  v_is_banned boolean := false;
  v_visibility text;
BEGIN
  IF p_actor_id IS NULL
    OR p_group_id IS NULL
    OR p_token_hash IS NULL
    OR p_token_hash !~ '^[0-9a-f]{64}$'
    OR p_pro_free_promo IS NULL
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'group-membership:' || p_group_id::text || ':' || p_actor_id::text,
      0
    )
  );

  SELECT invite.*
  INTO v_invite
  FROM public.group_invites AS invite
  WHERE invite.group_id = p_group_id
    AND invite.token_hash = p_token_hash
  FOR SHARE;
  v_invite_found := FOUND;

  IF NOT v_invite_found
    OR v_invite.revoked_at IS NOT NULL
    OR v_invite.expires_at <= pg_catalog.clock_timestamp()
    OR v_invite.used_count >= v_invite.max_uses
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid_invite');
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.group_invite_redemptions AS redemption
    WHERE redemption.invite_id = v_invite.id
      AND redemption.user_id = p_actor_id
  )
  INTO v_was_redeemed;
  IF v_was_redeemed THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invite_already_used');
  END IF;

  SELECT profile.*
  INTO v_profile
  FROM public.user_profiles AS profile
  WHERE profile.id = p_actor_id
  FOR UPDATE;
  v_profile_found := FOUND;
  IF NOT v_profile_found
    OR v_profile.deleted_at IS NOT NULL
    OR v_profile.banned_at IS NOT NULL
    OR (
      COALESCE(v_profile.is_banned, false)
      AND (
        v_profile.ban_expires_at IS NULL
        OR v_profile.ban_expires_at > pg_catalog.clock_timestamp()
      )
    )
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'account_inactive');
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

  SELECT EXISTS (
    SELECT 1
    FROM public.group_members AS member
    WHERE member.group_id = p_group_id
      AND member.user_id = p_actor_id
    FOR UPDATE
  )
  INTO v_is_member;
  IF v_is_member THEN
    RETURN pg_catalog.jsonb_build_object('status', 'already_member');
  END IF;

  PERFORM 1
  FROM public.group_bans AS ban
  WHERE ban.group_id = p_group_id
    AND ban.user_id = p_actor_id
  FOR UPDATE;
  v_is_banned := FOUND;
  IF v_is_banned THEN
    RETURN pg_catalog.jsonb_build_object('status', 'banned');
  END IF;

  IF COALESCE(v_group.min_arena_score, 0)
    > COALESCE(v_profile.reputation_score, 0)
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'score_too_low',
      'required_score', COALESCE(v_group.min_arena_score, 0)
    );
  END IF;
  IF COALESCE(v_group.is_verified_only, false)
    AND NOT COALESCE(v_profile.is_verified_trader, false)
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'verified_only');
  END IF;
  IF COALESCE(v_group.is_premium_only, false)
    AND NOT p_pro_free_promo
    AND COALESCE(v_profile.subscription_tier, 'free') <> 'pro'
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'premium_required');
  END IF;

  v_visibility := v_group.visibility::text;
  IF v_visibility IS NULL
    OR v_visibility NOT IN ('open', 'apply', 'private')
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invite_required');
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'status', 'valid',
    'invite_id', v_invite.id,
    'expires_at', v_invite.expires_at,
    'remaining_uses', v_invite.max_uses - v_invite.used_count
  );
END
$function$;

CREATE OR REPLACE FUNCTION public.create_group_invite_atomic(
  p_actor_id uuid,
  p_group_id uuid,
  p_token_hash text,
  p_expires_at timestamptz,
  p_max_uses integer DEFAULT 50
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_profile public.user_profiles%ROWTYPE;
  v_group public.groups%ROWTYPE;
  v_actor_role text;
  v_profile_found boolean := false;
  v_group_found boolean := false;
  v_actor_is_member boolean := false;
  v_recent_count integer := 0;
  v_invite_id uuid := pg_catalog.gen_random_uuid();
BEGIN
  IF p_actor_id IS NULL
    OR p_group_id IS NULL
    OR p_token_hash IS NULL
    OR p_token_hash !~ '^[0-9a-f]{64}$'
    OR p_expires_at IS NULL
    OR NOT pg_catalog.isfinite(p_expires_at)
    OR p_expires_at <= pg_catalog.clock_timestamp()
    OR p_expires_at > pg_catalog.clock_timestamp() + interval '30 days'
    OR p_max_uses IS NULL
    OR p_max_uses < 1
    OR p_max_uses > 100
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'group-membership:' || p_group_id::text || ':' || p_actor_id::text,
      0
    )
  );

  SELECT profile.*
  INTO v_profile
  FROM public.user_profiles AS profile
  WHERE profile.id = p_actor_id
  FOR UPDATE;
  v_profile_found := FOUND;
  IF NOT v_profile_found
    OR v_profile.deleted_at IS NOT NULL
    OR v_profile.banned_at IS NOT NULL
    OR (
      COALESCE(v_profile.is_banned, false)
      AND (
        v_profile.ban_expires_at IS NULL
        OR v_profile.ban_expires_at > pg_catalog.clock_timestamp()
      )
    )
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'account_inactive');
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

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('group-invite-create:' || p_actor_id::text, 0)
  );

  SELECT pg_catalog.count(*)::integer
  INTO v_recent_count
  FROM public.group_invites AS invite
  WHERE invite.created_by = p_actor_id
    AND invite.created_at >= pg_catalog.clock_timestamp() - interval '1 hour';
  IF v_recent_count >= 10 THEN
    RETURN pg_catalog.jsonb_build_object('status', 'rate_limited');
  END IF;

  BEGIN
    INSERT INTO public.group_invites (
      id,
      group_id,
      created_by,
      token_hash,
      max_uses,
      used_count,
      expires_at,
      created_at,
      revoked_at,
      revoked_by
    ) VALUES (
      v_invite_id,
      p_group_id,
      p_actor_id,
      p_token_hash,
      p_max_uses,
      0,
      p_expires_at,
      pg_catalog.clock_timestamp(),
      NULL,
      NULL
    );
  EXCEPTION
    WHEN unique_violation THEN
      RETURN pg_catalog.jsonb_build_object('status', 'token_conflict');
  END;

  INSERT INTO public.group_audit_log (
    group_id, actor_id, action, target_id, details
  ) VALUES (
    p_group_id,
    p_actor_id,
    'invite_created',
    NULL,
    pg_catalog.jsonb_build_object(
      'invite_id', v_invite_id,
      'max_uses', p_max_uses,
      'expires_at', p_expires_at
    )
  );

  RETURN pg_catalog.jsonb_build_object(
    'status', 'created',
    'invite_id', v_invite_id,
    'expires_at', p_expires_at
  );
END
$function$;

CREATE OR REPLACE FUNCTION public.revoke_group_invite_atomic(
  p_actor_id uuid,
  p_group_id uuid,
  p_invite_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_invite public.group_invites%ROWTYPE;
  v_profile public.user_profiles%ROWTYPE;
  v_group public.groups%ROWTYPE;
  v_actor_role text;
  v_invite_found boolean := false;
  v_profile_found boolean := false;
  v_group_found boolean := false;
  v_actor_is_member boolean := false;
  v_revoked_at timestamptz := pg_catalog.clock_timestamp();
  v_affected_count integer := 0;
BEGIN
  IF p_actor_id IS NULL OR p_group_id IS NULL OR p_invite_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'group-membership:' || p_group_id::text || ':' || p_actor_id::text,
      0
    )
  );

  SELECT invite.*
  INTO v_invite
  FROM public.group_invites AS invite
  WHERE invite.id = p_invite_id
    AND invite.group_id = p_group_id
  FOR UPDATE;
  v_invite_found := FOUND;

  SELECT profile.*
  INTO v_profile
  FROM public.user_profiles AS profile
  WHERE profile.id = p_actor_id
  FOR UPDATE;
  v_profile_found := FOUND;
  IF NOT v_profile_found
    OR v_profile.deleted_at IS NOT NULL
    OR v_profile.banned_at IS NOT NULL
    OR (
      COALESCE(v_profile.is_banned, false)
      AND (
        v_profile.ban_expires_at IS NULL
        OR v_profile.ban_expires_at > pg_catalog.clock_timestamp()
      )
    )
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'account_inactive');
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

  IF NOT v_invite_found THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invite_not_found');
  END IF;
  IF v_invite.revoked_at IS NOT NULL THEN
    RETURN pg_catalog.jsonb_build_object('status', 'already_revoked');
  END IF;

  UPDATE public.group_invites AS invite
  SET revoked_at = v_revoked_at,
      revoked_by = p_actor_id,
      expires_at = LEAST(invite.expires_at, v_revoked_at)
  WHERE invite.id = p_invite_id
    AND invite.group_id = p_group_id
    AND invite.revoked_at IS NULL;
  GET DIAGNOSTICS v_affected_count = ROW_COUNT;
  IF v_affected_count <> 1 THEN
    RAISE EXCEPTION 'atomic group invite revocation updated % rows',
      v_affected_count;
  END IF;

  INSERT INTO public.group_audit_log (
    group_id, actor_id, action, target_id, details
  ) VALUES (
    p_group_id,
    p_actor_id,
    'invite_revoked',
    NULL,
    pg_catalog.jsonb_build_object('invite_id', p_invite_id)
  );

  RETURN pg_catalog.jsonb_build_object('status', 'revoked');
END
$function$;

ALTER FUNCTION public.inspect_group_invite_atomic(uuid, uuid, text, boolean)
  OWNER TO postgres;
ALTER FUNCTION public.create_group_invite_atomic(
  uuid, uuid, text, timestamptz, integer
) OWNER TO postgres;
ALTER FUNCTION public.revoke_group_invite_atomic(uuid, uuid, uuid)
  OWNER TO postgres;

DO $converge_function_acls$
DECLARE
  signature pg_catalog.regprocedure;
  function_owner oid;
  grantee_info record;
BEGIN
  FOREACH signature IN ARRAY ARRAY[
    'public.inspect_group_invite_atomic(uuid,uuid,text,boolean)'::pg_catalog.regprocedure,
    'public.create_group_invite_atomic(uuid,uuid,text,timestamp with time zone,integer)'::pg_catalog.regprocedure,
    'public.revoke_group_invite_atomic(uuid,uuid,uuid)'::pg_catalog.regprocedure,
    'public.redeem_group_invite_atomic(uuid,uuid,text,boolean)'::pg_catalog.regprocedure
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

GRANT EXECUTE ON FUNCTION public.inspect_group_invite_atomic(
  uuid, uuid, text, boolean
) TO service_role;
GRANT EXECUTE ON FUNCTION public.create_group_invite_atomic(
  uuid, uuid, text, timestamptz, integer
) TO service_role;
GRANT EXECUTE ON FUNCTION public.revoke_group_invite_atomic(
  uuid, uuid, uuid
) TO service_role;
GRANT EXECUTE ON FUNCTION public.redeem_group_invite_atomic(
  uuid, uuid, text, boolean
) TO service_role;

DO $postflight$
DECLARE
  rpc_signature pg_catalog.regprocedure;
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
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_info
    WHERE constraint_info.conrelid = 'public.group_invites'::pg_catalog.regclass
      AND constraint_info.conname = 'group_invites_revocation_valid'
      AND constraint_info.contype = 'c'
      AND constraint_info.convalidated
  ) OR EXISTS (
    SELECT 1
    FROM public.group_invites AS invite
    WHERE (invite.revoked_at IS NULL) <> (invite.revoked_by IS NULL)
      OR (
        invite.revoked_at IS NOT NULL
        AND (
          NOT pg_catalog.isfinite(invite.revoked_at)
          OR invite.expires_at > invite.revoked_at
        )
      )
  ) THEN
    RAISE EXCEPTION 'group invite revocation evidence contract drifted';
  END IF;

  FOREACH rpc_signature IN ARRAY ARRAY[
    'public.inspect_group_invite_atomic(uuid,uuid,text,boolean)'::pg_catalog.regprocedure,
    'public.create_group_invite_atomic(uuid,uuid,text,timestamp with time zone,integer)'::pg_catalog.regprocedure,
    'public.revoke_group_invite_atomic(uuid,uuid,uuid)'::pg_catalog.regprocedure,
    'public.redeem_group_invite_atomic(uuid,uuid,text,boolean)'::pg_catalog.regprocedure
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS function_info
      WHERE function_info.oid = rpc_signature
        AND function_info.prosecdef
        AND pg_catalog.pg_get_userbyid(function_info.proowner) = 'postgres'
        AND function_info.proconfig =
          ARRAY['search_path=pg_catalog, public']::text[]
    ) OR NOT pg_catalog.has_function_privilege(
      'service_role', rpc_signature, 'EXECUTE'
    ) OR pg_catalog.has_function_privilege(
      'anon', rpc_signature, 'EXECUTE'
    ) OR pg_catalog.has_function_privilege(
      'authenticated', rpc_signature, 'EXECUTE'
    ) OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS function_info
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          function_info.proacl,
          pg_catalog.acldefault('f', function_info.proowner)
        )
      ) AS acl
      WHERE function_info.oid = rpc_signature
        AND acl.privilege_type = 'EXECUTE'
        AND acl.grantee NOT IN (function_info.proowner, service_oid)
    ) THEN
      RAISE EXCEPTION 'atomic group invitation RPC security drifted: %',
        rpc_signature;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_info
    WHERE function_info.pronamespace = 'public'::pg_catalog.regnamespace
      AND function_info.proname IN (
        'inspect_group_invite_atomic',
        'create_group_invite_atomic',
        'revoke_group_invite_atomic'
      )
      AND function_info.oid NOT IN (
        'public.inspect_group_invite_atomic(uuid,uuid,text,boolean)'::pg_catalog.regprocedure,
        'public.create_group_invite_atomic(uuid,uuid,text,timestamp with time zone,integer)'::pg_catalog.regprocedure,
        'public.revoke_group_invite_atomic(uuid,uuid,uuid)'::pg_catalog.regprocedure
      )
  ) THEN
    RAISE EXCEPTION 'unexpected atomic group invitation overload remains';
  END IF;

  IF NOT pg_catalog.has_table_privilege(
    'authenticated', 'public.group_invites', 'SELECT'
  ) OR pg_catalog.has_table_privilege(
    'authenticated', 'public.group_invites',
    'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
  ) OR NOT pg_catalog.has_table_privilege(
    'service_role', 'public.group_invites', 'SELECT'
  ) OR pg_catalog.has_table_privilege(
    'service_role', 'public.group_invites',
    'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
  ) OR pg_catalog.has_table_privilege(
    'anon', 'public.group_invites',
    'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
  ) THEN
    RAISE EXCEPTION 'group_invites effective ACL drifted';
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
    WHERE relation.oid = 'public.group_invites'::pg_catalog.regclass
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
    WHERE attribute.attrelid = 'public.group_invites'::pg_catalog.regclass
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND acl.grantee <> postgres_oid
  ) THEN
    RAISE EXCEPTION 'group_invites raw or column ACL drifted';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.group_invites'::pg_catalog.regclass
  ) <> 3 OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.group_invites'::pg_catalog.regclass
      AND policy.polname = 'internal_owner_mutation'
      AND policy.polcmd = '*'
      AND policy.polroles = ARRAY[postgres_oid]::oid[]
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.group_invites'::pg_catalog.regclass
      AND policy.polname = 'browser_creator_or_admin_read'
      AND policy.polcmd = 'r'
      AND policy.polroles = ARRAY[authenticated_oid]::oid[]
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.group_invites'::pg_catalog.regclass
      AND policy.polname = 'server_read'
      AND policy.polcmd = 'r'
      AND policy.polroles = ARRAY[service_oid]::oid[]
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = 'public.group_invites'::pg_catalog.regclass
      AND relation.relrowsecurity
      AND relation.relforcerowsecurity
  ) THEN
    RAISE EXCEPTION 'group_invites policy/RLS boundary drifted';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
