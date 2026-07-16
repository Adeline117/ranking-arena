-- Make apply-group request creation, cancellation and administrative review
-- service-owned transactions. Membership consumption remains owned by 113900.

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
    'group_join_requests',
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
      RAISE EXCEPTION 'postgres-owned join-request relation is missing: public.%',
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
        ('group_join_requests', 'id'),
        ('group_join_requests', 'group_id'),
        ('group_join_requests', 'user_id'),
        ('group_join_requests', 'answer_text'),
        ('group_join_requests', 'status'),
        ('group_join_requests', 'decided_by'),
        ('group_join_requests', 'decided_at'),
        ('group_join_requests', 'consumed_at'),
        ('group_join_requests', 'created_at'),
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
    RAISE EXCEPTION 'required atomic join-request columns are missing';
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
        ('group_join_requests', 'id', 'uuid'::pg_catalog.regtype),
        ('group_join_requests', 'group_id', 'uuid'::pg_catalog.regtype),
        ('group_join_requests', 'user_id', 'uuid'::pg_catalog.regtype),
        ('group_join_requests', 'answer_text', 'text'::pg_catalog.regtype),
        ('group_join_requests', 'status', 'text'::pg_catalog.regtype),
        ('group_join_requests', 'decided_by', 'uuid'::pg_catalog.regtype),
        ('group_join_requests', 'decided_at', 'timestamptz'::pg_catalog.regtype),
        ('group_join_requests', 'consumed_at', 'timestamptz'::pg_catalog.regtype),
        ('group_join_requests', 'created_at', 'timestamptz'::pg_catalog.regtype),
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
    RAISE EXCEPTION 'atomic join-request column types are incompatible';
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
    'public.serialize_group_membership_edge()'
  ) IS NULL OR pg_catalog.to_regprocedure(
    'public.enforce_group_join_request_state()'
  ) IS NULL OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_info
    WHERE trigger_info.tgrelid =
        'public.group_join_requests'::pg_catalog.regclass
      AND trigger_info.tgname = 'trg_group_join_requests_05_enforce_state'
      AND trigger_info.tgfoid =
        'public.enforce_group_join_request_state()'::pg_catalog.regprocedure
      AND trigger_info.tgenabled = 'O'
      AND trigger_info.tgtype = 23
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index AS index_info
    JOIN pg_catalog.pg_attribute AS first_attribute
      ON first_attribute.attrelid = index_info.indrelid
     AND first_attribute.attnum = index_info.indkey[0]
    JOIN pg_catalog.pg_attribute AS second_attribute
      ON second_attribute.attrelid = index_info.indrelid
     AND second_attribute.attnum = index_info.indkey[1]
    WHERE index_info.indexrelid =
        'public.group_join_requests_active_edge_unique'::pg_catalog.regclass
      AND index_info.indrelid =
        'public.group_join_requests'::pg_catalog.regclass
      AND index_info.indisunique
      AND index_info.indisvalid
      AND index_info.indisready
      AND index_info.indnkeyatts = 2
      AND index_info.indnatts = 2
      AND index_info.indexprs IS NULL
      AND index_info.indpred IS NOT NULL
      AND first_attribute.attname = 'group_id'
      AND second_attribute.attname = 'user_id'
      AND pg_catalog.pg_get_expr(index_info.indpred, index_info.indrelid, true)
        = 'status = ANY (ARRAY[''pending''::text, ''approved''::text])'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_info
    WHERE constraint_info.conrelid =
        'public.group_join_requests'::pg_catalog.regclass
      AND constraint_info.contype = 'p'
      AND constraint_info.convalidated
      AND NOT constraint_info.condeferrable
      AND constraint_info.conkey = ARRAY[
        (
          SELECT attribute.attnum
          FROM pg_catalog.pg_attribute AS attribute
          WHERE attribute.attrelid = constraint_info.conrelid
            AND attribute.attname = 'id'
        )
      ]::smallint[]
  ) THEN
    RAISE EXCEPTION 'atomic membership migration 20260716113900 must be applied first';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_info
    WHERE function_info.pronamespace = 'public'::pg_catalog.regnamespace
      AND function_info.proname = 'mutate_group_join_request_atomic'
      AND pg_catalog.pg_get_function_identity_arguments(function_info.oid)
        <> 'p_actor_id uuid, p_group_id uuid, p_action text, p_answer_text text, p_pro_free_promo boolean'
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_info
    WHERE function_info.pronamespace = 'public'::pg_catalog.regnamespace
      AND function_info.proname = 'review_group_join_request_atomic'
      AND pg_catalog.pg_get_function_identity_arguments(function_info.oid)
        <> 'p_actor_id uuid, p_request_id uuid, p_decision text'
  ) THEN
    RAISE EXCEPTION 'unexpected atomic group join-request overload exists';
  END IF;
END
$preflight$;

LOCK TABLE
  public.groups,
  public.user_profiles,
  public.group_members,
  public.group_bans,
  public.group_join_requests,
  public.group_audit_log
IN ACCESS EXCLUSIVE MODE;

ALTER TABLE public.group_join_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.group_join_requests FORCE ROW LEVEL SECURITY;

DO $replace_request_policies$
DECLARE
  policy_info record;
BEGIN
  FOR policy_info IN
    SELECT policy.polname
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid =
        'public.group_join_requests'::pg_catalog.regclass
  LOOP
    EXECUTE pg_catalog.format(
      'DROP POLICY %I ON public.group_join_requests',
      policy_info.polname
    );
  END LOOP;
END
$replace_request_policies$;

DO $converge_request_acls$
DECLARE
  relation_oid oid := 'public.group_join_requests'::pg_catalog.regclass;
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
      EXECUTE 'REVOKE ALL PRIVILEGES ON TABLE public.group_join_requests FROM PUBLIC';
    ELSIF grantee_info.rolname IS NOT NULL THEN
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON TABLE public.group_join_requests FROM %I',
        grantee_info.rolname
      );
    END IF;
  END LOOP;

  REVOKE ALL PRIVILEGES ON TABLE public.group_join_requests
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
          || 'ON TABLE public.group_join_requests FROM PUBLIC',
        column_list
      );
    ELSIF grantee_info.rolname IS NOT NULL THEN
      EXECUTE pg_catalog.format(
        'REVOKE SELECT (%1$s), INSERT (%1$s), UPDATE (%1$s), REFERENCES (%1$s) '
          || 'ON TABLE public.group_join_requests FROM %2$I',
        column_list,
        grantee_info.rolname
      );
    END IF;
  END LOOP;
END
$converge_request_acls$;

GRANT SELECT ON TABLE public.group_join_requests TO authenticated, service_role;

CREATE POLICY internal_owner_mutation
  ON public.group_join_requests
  AS PERMISSIVE
  FOR ALL
  TO postgres
  USING (true)
  WITH CHECK (true);

CREATE POLICY browser_self_or_admin_read
  ON public.group_join_requests
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (
    user_id = (SELECT auth.uid())
    OR EXISTS (
      SELECT 1
      FROM public.group_members AS administrator
      WHERE administrator.group_id = group_join_requests.group_id
        AND administrator.user_id = (SELECT auth.uid())
        AND administrator.role IN (
          'owner'::public.member_role,
          'admin'::public.member_role
        )
    )
  );

CREATE POLICY server_read
  ON public.group_join_requests
  AS PERMISSIVE
  FOR SELECT
  TO service_role
  USING (true);

CREATE OR REPLACE FUNCTION public.mutate_group_join_request_atomic(
  p_actor_id uuid,
  p_group_id uuid,
  p_action text,
  p_answer_text text DEFAULT NULL,
  p_pro_free_promo boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_profile public.user_profiles%ROWTYPE;
  v_group public.groups%ROWTYPE;
  v_active_request public.group_join_requests%ROWTYPE;
  v_profile_found boolean := false;
  v_group_found boolean := false;
  v_is_member boolean := false;
  v_is_banned boolean := false;
  v_request_found boolean := false;
  v_request_id uuid;
  v_answer_text text := pg_catalog.btrim(COALESCE(p_answer_text, ''));
  v_visibility text;
  v_affected_count integer := 0;
BEGIN
  IF p_actor_id IS NULL
    OR p_group_id IS NULL
    OR p_action IS NULL
    OR p_action NOT IN ('request', 'cancel')
    OR p_pro_free_promo IS NULL
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;
  IF pg_catalog.char_length(COALESCE(p_answer_text, '')) > 2000 THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid_answer');
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

  SELECT EXISTS (
    SELECT 1
    FROM public.group_members AS member
    WHERE member.group_id = p_group_id
      AND member.user_id = p_actor_id
    FOR UPDATE
  )
  INTO v_is_member;

  PERFORM 1
  FROM public.group_bans AS ban
  WHERE ban.group_id = p_group_id
    AND ban.user_id = p_actor_id
  FOR UPDATE;
  v_is_banned := FOUND;

  SELECT join_request.*
  INTO v_active_request
  FROM public.group_join_requests AS join_request
  WHERE join_request.group_id = p_group_id
    AND join_request.user_id = p_actor_id
    AND join_request.status IN ('pending', 'approved')
  ORDER BY join_request.created_at, join_request.id
  LIMIT 1
  FOR UPDATE;
  v_request_found := FOUND;

  IF p_action = 'cancel' THEN
    IF NOT v_request_found THEN
      RETURN pg_catalog.jsonb_build_object('status', 'no_request');
    END IF;

    UPDATE public.group_join_requests AS join_request
    SET status = 'cancelled'
    WHERE join_request.id = v_active_request.id
      AND join_request.status IN ('pending', 'approved');
    GET DIAGNOSTICS v_affected_count = ROW_COUNT;
    IF v_affected_count <> 1 THEN
      RAISE EXCEPTION 'atomic join-request cancellation updated % rows',
        v_affected_count;
    END IF;

    INSERT INTO public.group_audit_log (
      group_id, actor_id, action, target_id, details
    ) VALUES (
      p_group_id,
      p_actor_id,
      'join_request_cancelled',
      p_actor_id,
      pg_catalog.jsonb_build_object('request_id', v_active_request.id)
    );

    RETURN pg_catalog.jsonb_build_object(
      'status', 'cancelled',
      'request_id', v_active_request.id
    );
  END IF;

  IF v_group.dissolved_at IS NOT NULL THEN
    RETURN pg_catalog.jsonb_build_object('status', 'dissolved');
  END IF;
  IF v_is_member THEN
    RETURN pg_catalog.jsonb_build_object('status', 'already_member');
  END IF;
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
  IF v_visibility = 'open' THEN
    RETURN pg_catalog.jsonb_build_object('status', 'open_group');
  END IF;
  IF v_visibility IS DISTINCT FROM 'apply' THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invite_required');
  END IF;

  IF v_request_found THEN
    RETURN pg_catalog.jsonb_build_object(
      'status',
      CASE
        WHEN v_active_request.status = 'approved' THEN 'already_approved'
        ELSE 'already_pending'
      END,
      'request_id', v_active_request.id
    );
  END IF;

  v_request_id := pg_catalog.gen_random_uuid();
  INSERT INTO public.group_join_requests (
    id, group_id, user_id, answer_text, status
  ) VALUES (
    v_request_id, p_group_id, p_actor_id, v_answer_text, 'pending'
  );

  INSERT INTO public.group_audit_log (
    group_id, actor_id, action, target_id, details
  ) VALUES (
    p_group_id,
    p_actor_id,
    'join_request_created',
    p_actor_id,
    pg_catalog.jsonb_build_object('request_id', v_request_id)
  );

  RETURN pg_catalog.jsonb_build_object(
    'status', 'requested',
    'request_id', v_request_id
  );
END
$function$;

CREATE OR REPLACE FUNCTION public.review_group_join_request_atomic(
  p_actor_id uuid,
  p_request_id uuid,
  p_decision text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_initial_request public.group_join_requests%ROWTYPE;
  v_request public.group_join_requests%ROWTYPE;
  v_actor_profile public.user_profiles%ROWTYPE;
  v_target_profile public.user_profiles%ROWTYPE;
  v_group public.groups%ROWTYPE;
  v_actor_role text;
  v_initial_found boolean := false;
  v_request_found boolean := false;
  v_actor_found boolean := false;
  v_target_found boolean := false;
  v_group_found boolean := false;
  v_actor_is_member boolean := false;
  v_target_is_member boolean := false;
  v_target_is_banned boolean := false;
  v_affected_count integer := 0;
  v_first_edge text;
  v_second_edge text;
BEGIN
  IF p_actor_id IS NULL
    OR p_request_id IS NULL
    OR p_decision IS NULL
    OR p_decision NOT IN ('approve', 'reject')
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;

  SELECT join_request.*
  INTO v_initial_request
  FROM public.group_join_requests AS join_request
  WHERE join_request.id = p_request_id;
  v_initial_found := FOUND;
  IF NOT v_initial_found THEN
    RETURN pg_catalog.jsonb_build_object('status', 'request_not_found');
  END IF;

  v_first_edge := 'group-membership:' || v_initial_request.group_id::text || ':'
    || LEAST(p_actor_id::text, v_initial_request.user_id::text);
  v_second_edge := 'group-membership:' || v_initial_request.group_id::text || ':'
    || GREATEST(p_actor_id::text, v_initial_request.user_id::text);

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
  WHERE profile.id IN (p_actor_id, v_initial_request.user_id)
  ORDER BY profile.id
  FOR UPDATE;

  SELECT profile.*
  INTO v_actor_profile
  FROM public.user_profiles AS profile
  WHERE profile.id = p_actor_id;
  v_actor_found := FOUND;
  IF NOT v_actor_found
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
  WHERE profile.id = v_initial_request.user_id;
  v_target_found := FOUND;

  SELECT target_group.*
  INTO v_group
  FROM public.groups AS target_group
  WHERE target_group.id = v_initial_request.group_id
  FOR UPDATE;
  v_group_found := FOUND;
  IF NOT v_group_found THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  SELECT member.role::text
  INTO v_actor_role
  FROM public.group_members AS member
  WHERE member.group_id = v_initial_request.group_id
    AND member.user_id = p_actor_id
  FOR UPDATE;
  v_actor_is_member := FOUND;
  IF NOT v_actor_is_member OR v_actor_role NOT IN ('owner', 'admin') THEN
    RETURN pg_catalog.jsonb_build_object('status', 'forbidden');
  END IF;

  SELECT join_request.*
  INTO v_request
  FROM public.group_join_requests AS join_request
  WHERE join_request.id = p_request_id
  FOR UPDATE;
  v_request_found := FOUND;
  IF NOT v_request_found
    OR v_request.group_id IS DISTINCT FROM v_initial_request.group_id
    OR v_request.user_id IS DISTINCT FROM v_initial_request.user_id
  THEN
    RAISE EXCEPTION 'join-request identity changed during atomic review';
  END IF;

  IF v_request.status IN ('joined', 'rejected', 'cancelled') THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'already_processed',
      'request_status', v_request.status
    );
  END IF;
  IF p_decision = 'approve' AND v_request.status = 'approved' THEN
    RETURN pg_catalog.jsonb_build_object('status', 'already_approved');
  END IF;

  IF p_decision = 'reject' THEN
    UPDATE public.group_join_requests AS join_request
    SET status = 'rejected',
        decided_by = p_actor_id,
        decided_at = pg_catalog.clock_timestamp()
    WHERE join_request.id = p_request_id
      AND join_request.status IN ('pending', 'approved');
    GET DIAGNOSTICS v_affected_count = ROW_COUNT;
    IF v_affected_count <> 1 THEN
      RAISE EXCEPTION 'atomic join-request rejection updated % rows',
        v_affected_count;
    END IF;

    INSERT INTO public.group_audit_log (
      group_id, actor_id, action, target_id, details
    ) VALUES (
      v_request.group_id,
      p_actor_id,
      'join_request_rejected',
      v_request.user_id,
      pg_catalog.jsonb_build_object('request_id', p_request_id)
    );

    RETURN pg_catalog.jsonb_build_object('status', 'rejected');
  END IF;

  IF v_group.dissolved_at IS NOT NULL THEN
    RETURN pg_catalog.jsonb_build_object('status', 'dissolved');
  END IF;
  IF NOT v_target_found THEN
    RETURN pg_catalog.jsonb_build_object('status', 'target_not_found');
  END IF;
  IF v_target_profile.deleted_at IS NOT NULL
    OR v_target_profile.banned_at IS NOT NULL
    OR (
      COALESCE(v_target_profile.is_banned, false)
      AND (
        v_target_profile.ban_expires_at IS NULL
        OR v_target_profile.ban_expires_at > pg_catalog.clock_timestamp()
      )
    )
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'target_inactive');
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.group_members AS member
    WHERE member.group_id = v_request.group_id
      AND member.user_id = v_request.user_id
    FOR UPDATE
  )
  INTO v_target_is_member;

  PERFORM 1
  FROM public.group_bans AS ban
  WHERE ban.group_id = v_request.group_id
    AND ban.user_id = v_request.user_id
  FOR UPDATE;
  v_target_is_banned := FOUND;

  IF v_target_is_banned THEN
    RETURN pg_catalog.jsonb_build_object('status', 'target_banned');
  END IF;

  IF v_target_is_member THEN
    UPDATE public.group_join_requests AS join_request
    SET status = 'joined',
        consumed_at = pg_catalog.clock_timestamp()
    WHERE join_request.id = p_request_id
      AND join_request.status IN ('pending', 'approved');
    GET DIAGNOSTICS v_affected_count = ROW_COUNT;
    IF v_affected_count <> 1 THEN
      RAISE EXCEPTION 'atomic join-request reconciliation updated % rows',
        v_affected_count;
    END IF;

    INSERT INTO public.group_audit_log (
      group_id, actor_id, action, target_id, details
    ) VALUES (
      v_request.group_id,
      p_actor_id,
      'join_request_reconciled',
      v_request.user_id,
      pg_catalog.jsonb_build_object('request_id', p_request_id)
    );

    RETURN pg_catalog.jsonb_build_object('status', 'already_member');
  END IF;

  UPDATE public.group_join_requests AS join_request
  SET status = 'approved',
      decided_by = p_actor_id,
      decided_at = pg_catalog.clock_timestamp()
  WHERE join_request.id = p_request_id
    AND join_request.status = 'pending';
  GET DIAGNOSTICS v_affected_count = ROW_COUNT;
  IF v_affected_count <> 1 THEN
    RAISE EXCEPTION 'atomic join-request approval updated % rows',
      v_affected_count;
  END IF;

  INSERT INTO public.group_audit_log (
    group_id, actor_id, action, target_id, details
  ) VALUES (
    v_request.group_id,
    p_actor_id,
    'join_request_approved',
    v_request.user_id,
    pg_catalog.jsonb_build_object('request_id', p_request_id)
  );

  RETURN pg_catalog.jsonb_build_object('status', 'approved');
END
$function$;

ALTER FUNCTION public.mutate_group_join_request_atomic(
  uuid, uuid, text, text, boolean
) OWNER TO postgres;
ALTER FUNCTION public.review_group_join_request_atomic(uuid, uuid, text)
  OWNER TO postgres;

DO $converge_function_acls$
DECLARE
  signature pg_catalog.regprocedure;
  function_owner oid;
  grantee_info record;
BEGIN
  FOREACH signature IN ARRAY ARRAY[
    'public.mutate_group_join_request_atomic(uuid,uuid,text,text,boolean)'::pg_catalog.regprocedure,
    'public.review_group_join_request_atomic(uuid,uuid,text)'::pg_catalog.regprocedure
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

GRANT EXECUTE ON FUNCTION public.mutate_group_join_request_atomic(
  uuid, uuid, text, text, boolean
) TO service_role;
GRANT EXECUTE ON FUNCTION public.review_group_join_request_atomic(
  uuid, uuid, text
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
  FOREACH rpc_signature IN ARRAY ARRAY[
    'public.mutate_group_join_request_atomic(uuid,uuid,text,text,boolean)'::pg_catalog.regprocedure,
    'public.review_group_join_request_atomic(uuid,uuid,text)'::pg_catalog.regprocedure
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
      RAISE EXCEPTION 'atomic join-request RPC security drifted: %',
        rpc_signature;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_info
    WHERE function_info.pronamespace = 'public'::pg_catalog.regnamespace
      AND function_info.proname IN (
        'mutate_group_join_request_atomic',
        'review_group_join_request_atomic'
      )
      AND function_info.oid NOT IN (
        'public.mutate_group_join_request_atomic(uuid,uuid,text,text,boolean)'::pg_catalog.regprocedure,
        'public.review_group_join_request_atomic(uuid,uuid,text)'::pg_catalog.regprocedure
      )
  ) THEN
    RAISE EXCEPTION 'unexpected atomic group join-request overload remains';
  END IF;

  IF NOT pg_catalog.has_table_privilege(
    'authenticated', 'public.group_join_requests', 'SELECT'
  ) OR pg_catalog.has_table_privilege(
    'authenticated', 'public.group_join_requests',
    'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
  ) OR NOT pg_catalog.has_table_privilege(
    'service_role', 'public.group_join_requests', 'SELECT'
  ) OR pg_catalog.has_table_privilege(
    'service_role', 'public.group_join_requests',
    'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
  ) OR pg_catalog.has_table_privilege(
    'anon', 'public.group_join_requests',
    'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
  ) THEN
    RAISE EXCEPTION 'group_join_requests effective ACL drifted';
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
    WHERE relation.oid = 'public.group_join_requests'::pg_catalog.regclass
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
    WHERE attribute.attrelid =
        'public.group_join_requests'::pg_catalog.regclass
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND acl.grantee <> postgres_oid
  ) THEN
    RAISE EXCEPTION 'group_join_requests raw or column ACL drifted';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid =
        'public.group_join_requests'::pg_catalog.regclass
  ) <> 3 OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid =
        'public.group_join_requests'::pg_catalog.regclass
      AND policy.polname = 'internal_owner_mutation'
      AND policy.polcmd = '*'
      AND policy.polroles = ARRAY[postgres_oid]::oid[]
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid =
        'public.group_join_requests'::pg_catalog.regclass
      AND policy.polname = 'browser_self_or_admin_read'
      AND policy.polcmd = 'r'
      AND policy.polroles = ARRAY[authenticated_oid]::oid[]
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid =
        'public.group_join_requests'::pg_catalog.regclass
      AND policy.polname = 'server_read'
      AND policy.polcmd = 'r'
      AND policy.polroles = ARRAY[service_oid]::oid[]
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = 'public.group_join_requests'::pg_catalog.regclass
      AND relation.relrowsecurity
      AND relation.relforcerowsecurity
  ) THEN
    RAISE EXCEPTION 'group_join_requests policy/RLS boundary drifted';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_info
    WHERE trigger_info.tgrelid =
        'public.group_join_requests'::pg_catalog.regclass
      AND trigger_info.tgname = 'trg_group_join_requests_05_enforce_state'
      AND trigger_info.tgfoid =
        'public.enforce_group_join_request_state()'::pg_catalog.regprocedure
      AND trigger_info.tgenabled = 'O'
      AND trigger_info.tgtype = 23
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index AS index_info
    JOIN pg_catalog.pg_attribute AS first_attribute
      ON first_attribute.attrelid = index_info.indrelid
     AND first_attribute.attnum = index_info.indkey[0]
    JOIN pg_catalog.pg_attribute AS second_attribute
      ON second_attribute.attrelid = index_info.indrelid
     AND second_attribute.attnum = index_info.indkey[1]
    WHERE index_info.indexrelid =
        'public.group_join_requests_active_edge_unique'::pg_catalog.regclass
      AND index_info.indrelid =
        'public.group_join_requests'::pg_catalog.regclass
      AND index_info.indisunique
      AND index_info.indisvalid
      AND index_info.indisready
      AND index_info.indnkeyatts = 2
      AND index_info.indnatts = 2
      AND index_info.indexprs IS NULL
      AND index_info.indpred IS NOT NULL
      AND first_attribute.attname = 'group_id'
      AND second_attribute.attname = 'user_id'
      AND pg_catalog.pg_get_expr(index_info.indpred, index_info.indrelid, true)
        = 'status = ANY (ARRAY[''pending''::text, ''approved''::text])'
  ) THEN
    RAISE EXCEPTION 'join-request state/index authority drifted';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
