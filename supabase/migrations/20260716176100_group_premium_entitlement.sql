-- One premium-group entitlement predicate for current group passes, global Pro,
-- membership entry points, and browser post read/write policies.

BEGIN;

SET LOCAL search_path = pg_catalog, pg_temp;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('group-application-authority-migrations', 0)
);
SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended(
    'public.group_subscriptions:server-authority:v1',
    0
  )
);

DO $preflight$
DECLARE
  v_postgres oid := (
    SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'postgres'
  );
  v_service oid := (
    SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'service_role'
  );
  v_authenticator oid := (
    SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'authenticator'
  );
  v_relation text;
  v_signature pg_catalog.regprocedure;
  v_source text;
  v_old_expression constant text :=
    'COALESCE(v_profile.subscription_tier, ''free'') <> ''pro''';
  v_new_expression constant text :=
    'NOT public.has_current_group_entitlement(p_actor_id, p_group_id)';
BEGIN
  IF v_postgres IS NULL
    OR v_service IS NULL
    OR v_authenticator IS NULL
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.unnest(
        ARRAY['anon', 'authenticated']::name[]
      ) AS required_role(role_name)
      LEFT JOIN pg_catalog.pg_roles AS role_row
        ON role_row.rolname = required_role.role_name
      WHERE role_row.oid IS NULL
    )
  THEN
    RAISE EXCEPTION 'group premium entitlement requires standard Supabase roles';
  END IF;

  FOREACH v_relation IN ARRAY ARRAY[
    'groups',
    'user_profiles',
    'subscriptions',
    'group_subscriptions',
    'group_members',
    'group_bans',
    'group_join_requests',
    'group_invites',
    'group_invite_redemptions',
    'group_audit_log',
    'blocked_users',
    'user_follows',
    'posts'
  ]::text[]
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS relation
      WHERE relation.oid = pg_catalog.to_regclass('public.' || v_relation)
        AND relation.relkind = 'r'
        AND relation.relpersistence = 'p'
        AND NOT relation.relispartition
        AND relation.relowner = v_postgres
    ) OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_inherits AS inheritance
      WHERE inheritance.inhrelid =
          pg_catalog.to_regclass('public.' || v_relation)
         OR inheritance.inhparent =
          pg_catalog.to_regclass('public.' || v_relation)
    ) THEN
      RAISE EXCEPTION 'premium entitlement relation is incompatible: public.%',
        v_relation;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('groups', 'id', 'uuid'::pg_catalog.regtype),
        ('groups', 'created_by', 'uuid'::pg_catalog.regtype),
        ('groups', 'is_premium_only', 'boolean'::pg_catalog.regtype),
        ('groups', 'visibility', 'public.group_visibility'::pg_catalog.regtype),
        ('groups', 'dissolved_at', 'timestamptz'::pg_catalog.regtype),
        ('user_profiles', 'id', 'uuid'::pg_catalog.regtype),
        ('user_profiles', 'deleted_at', 'timestamptz'::pg_catalog.regtype),
        ('user_profiles', 'banned_at', 'timestamptz'::pg_catalog.regtype),
        ('user_profiles', 'is_banned', 'boolean'::pg_catalog.regtype),
        ('user_profiles', 'ban_expires_at', 'timestamptz'::pg_catalog.regtype),
        ('user_profiles', 'subscription_tier', 'text'::pg_catalog.regtype),
        ('user_profiles', 'pro_expires_at', 'timestamptz'::pg_catalog.regtype),
        ('subscriptions', 'user_id', 'uuid'::pg_catalog.regtype),
        ('subscriptions', 'tier', 'text'::pg_catalog.regtype),
        ('subscriptions', 'plan', 'text'::pg_catalog.regtype),
        ('subscriptions', 'status', 'text'::pg_catalog.regtype),
        ('subscriptions', 'current_period_end', 'timestamptz'::pg_catalog.regtype),
        ('group_subscriptions', 'group_id', 'uuid'::pg_catalog.regtype),
        ('group_subscriptions', 'user_id', 'uuid'::pg_catalog.regtype),
        ('group_subscriptions', 'status', 'text'::pg_catalog.regtype),
        ('group_subscriptions', 'expires_at', 'timestamptz'::pg_catalog.regtype),
        ('group_members', 'group_id', 'uuid'::pg_catalog.regtype),
        ('group_members', 'user_id', 'uuid'::pg_catalog.regtype),
        ('group_members', 'role', 'public.member_role'::pg_catalog.regtype),
        ('group_members', 'muted_until', 'timestamptz'::pg_catalog.regtype),
        ('group_bans', 'group_id', 'uuid'::pg_catalog.regtype),
        ('group_bans', 'user_id', 'uuid'::pg_catalog.regtype),
        ('blocked_users', 'blocker_id', 'uuid'::pg_catalog.regtype),
        ('blocked_users', 'blocked_id', 'uuid'::pg_catalog.regtype),
        ('user_follows', 'follower_id', 'uuid'::pg_catalog.regtype),
        ('user_follows', 'following_id', 'uuid'::pg_catalog.regtype),
        ('posts', 'id', 'uuid'::pg_catalog.regtype),
        ('posts', 'group_id', 'uuid'::pg_catalog.regtype),
        ('posts', 'author_id', 'uuid'::pg_catalog.regtype),
        ('posts', 'original_post_id', 'uuid'::pg_catalog.regtype),
        ('posts', 'title', 'text'::pg_catalog.regtype),
        ('posts', 'content', 'text'::pg_catalog.regtype),
        ('posts', 'poll_enabled', 'boolean'::pg_catalog.regtype),
        ('posts', 'images', 'text[]'::pg_catalog.regtype),
        ('posts', 'is_sensitive', 'boolean'::pg_catalog.regtype),
        ('posts', 'content_warning', 'text'::pg_catalog.regtype),
        ('posts', 'visibility', 'text'::pg_catalog.regtype),
        ('posts', 'status', 'public.post_status'::pg_catalog.regtype),
        ('posts', 'deleted_at', 'timestamptz'::pg_catalog.regtype)
    ) AS required_column(relation_name, column_name, type_oid)
    LEFT JOIN pg_catalog.pg_attribute AS attribute
      ON attribute.attrelid = pg_catalog.to_regclass(
        'public.' || required_column.relation_name
      )
     AND attribute.attname = required_column.column_name
     AND attribute.attnum > 0
     AND NOT attribute.attisdropped
    WHERE attribute.attnum IS NULL
       OR attribute.atttypid <> required_column.type_oid
       OR attribute.attgenerated <> ''
  ) THEN
    RAISE EXCEPTION 'premium entitlement columns are missing or incompatible';
  END IF;

  IF pg_catalog.to_regprocedure('auth.uid()') IS NULL
    OR pg_catalog.to_regprocedure('auth.role()') IS NULL
    OR NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS function_row
      WHERE function_row.oid = 'auth.uid()'::pg_catalog.regprocedure
        AND function_row.prorettype = 'uuid'::pg_catalog.regtype
    )
    OR NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS function_row
      WHERE function_row.oid = 'auth.role()'::pg_catalog.regprocedure
        AND function_row.prorettype = 'text'::pg_catalog.regtype
    )
  THEN
    RAISE EXCEPTION 'auth identity helpers are missing';
  END IF;

  IF NOT pg_catalog.has_schema_privilege(v_postgres, 'auth', 'USAGE')
    OR NOT pg_catalog.has_function_privilege(
      v_postgres,
      'auth.uid()'::pg_catalog.regprocedure,
      'EXECUTE'
    )
    OR NOT pg_catalog.has_function_privilege(
      v_postgres,
      'auth.role()'::pg_catalog.regprocedure,
      'EXECUTE'
    )
  THEN
    RAISE EXCEPTION 'postgres function owner cannot execute auth identity helpers';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_auth_members AS membership
    WHERE membership.roleid = v_service
      AND membership.member = v_authenticator
      AND NOT membership.admin_option
      AND NOT membership.inherit_option
      AND membership.set_option
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_auth_members AS membership
    WHERE membership.roleid = v_service
      AND membership.member NOT IN (v_authenticator, v_postgres)
  ) OR EXISTS (
    WITH RECURSIVE service_inheritors(member_oid) AS (
      SELECT membership.member
      FROM pg_catalog.pg_auth_members AS membership
      WHERE membership.roleid = v_service
        AND membership.inherit_option
      UNION
      SELECT membership.member
      FROM pg_catalog.pg_auth_members AS membership
      JOIN service_inheritors AS inherited
        ON membership.roleid = inherited.member_oid
      WHERE membership.inherit_option OR membership.set_option
    )
    SELECT 1
    FROM service_inheritors AS inherited
    JOIN pg_catalog.pg_roles AS role_row
      ON role_row.oid = inherited.member_oid
    WHERE inherited.member_oid <> v_postgres
      AND NOT (
        role_row.rolname = 'cli_login_postgres'
        AND role_row.rolcanlogin
        AND NOT role_row.rolinherit
        AND NOT role_row.rolcreaterole
        AND NOT role_row.rolcreatedb
        AND NOT role_row.rolreplication
        AND NOT role_row.rolbypassrls
        AND NOT role_row.rolsuper
        AND EXISTS (
          SELECT 1
          FROM pg_catalog.pg_auth_members AS managed_membership
          WHERE managed_membership.roleid = v_postgres
            AND managed_membership.member = role_row.oid
            AND NOT managed_membership.admin_option
            AND NOT managed_membership.inherit_option
            AND managed_membership.set_option
        )
      )
  ) OR EXISTS (
    WITH RECURSIVE service_inherits(role_oid) AS (
      SELECT membership.roleid
      FROM pg_catalog.pg_auth_members AS membership
      WHERE membership.member = v_service
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
    SELECT 1
    FROM browser_authority AS inherited
    WHERE inherited.role_oid IN (v_service, v_postgres)
  ) THEN
    RAISE EXCEPTION 'group premium entitlement service-role graph is unsafe';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.pronamespace = 'public'::pg_catalog.regnamespace
      AND function_row.proname IN (
        'has_current_global_pro_entitlement',
        'has_current_group_entitlement',
        'current_user_has_current_group_entitlement',
        'current_user_can_read_post_with_current_entitlement',
        'service_actor_has_current_group_entitlement',
        'service_actor_has_current_global_pro_entitlement',
        'enforce_current_group_post_publish'
      )
      AND NOT (
        (
          function_row.proname IN (
            'has_current_global_pro_entitlement',
            'service_actor_has_current_global_pro_entitlement'
          )
          AND pg_catalog.pg_get_function_identity_arguments(function_row.oid)
            = 'p_actor_id uuid'
        )
        OR (
          function_row.proname IN (
            'has_current_group_entitlement',
            'service_actor_has_current_group_entitlement'
          )
          AND pg_catalog.pg_get_function_identity_arguments(function_row.oid)
            = 'p_actor_id uuid, p_group_id uuid'
        )
        OR (
          function_row.proname =
            'current_user_has_current_group_entitlement'
          AND pg_catalog.pg_get_function_identity_arguments(function_row.oid)
            = 'p_group_id uuid'
        )
        OR (
          function_row.proname =
            'current_user_can_read_post_with_current_entitlement'
          AND pg_catalog.pg_get_function_identity_arguments(function_row.oid)
            = 'p_post_id uuid'
        )
        OR (
          function_row.proname = 'enforce_current_group_post_publish'
          AND pg_catalog.pg_get_function_identity_arguments(function_row.oid) = ''
        )
      )
  ) THEN
    RAISE EXCEPTION 'unexpected premium entitlement helper overload exists';
  END IF;

  FOREACH v_signature IN ARRAY ARRAY[
    'public.mutate_group_membership_atomic(uuid,uuid,text,boolean)'::pg_catalog.regprocedure,
    'public.redeem_group_invite_atomic(uuid,uuid,text,boolean)'::pg_catalog.regprocedure,
    'public.mutate_group_join_request_atomic(uuid,uuid,text,text,boolean)'::pg_catalog.regprocedure,
    'public.inspect_group_invite_atomic(uuid,uuid,text,boolean)'::pg_catalog.regprocedure
  ]
  LOOP
    SELECT function_row.prosrc
    INTO STRICT v_source
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_signature
      AND function_row.proowner = v_postgres
      AND function_row.prosecdef;

    IF pg_catalog.strpos(v_source, v_new_expression) > 0 THEN
      IF pg_catalog.strpos(v_source, v_old_expression) > 0
        OR pg_catalog.strpos(
          pg_catalog.replace(v_source, v_new_expression, ''),
          v_new_expression
        ) > 0
      THEN
        RAISE EXCEPTION 'membership entry point contains mixed premium predicates: %',
          v_signature;
      END IF;
    ELSIF pg_catalog.strpos(v_source, v_old_expression) = 0
      OR pg_catalog.strpos(
        pg_catalog.replace(v_source, v_old_expression, ''),
        v_old_expression
      ) > 0
    THEN
      RAISE EXCEPTION 'membership entry-point premium predicate drifted: %',
        v_signature;
    END IF;
  END LOOP;

  FOREACH v_signature IN ARRAY ARRAY[
    'public.can_actor_read_post_fields(uuid,uuid,uuid,text,public.post_status,timestamptz)'::pg_catalog.regprocedure,
    'public.can_actor_read_post_id(uuid,uuid)'::pg_catalog.regprocedure,
    'public.can_service_actor_read_post(uuid,uuid)'::pg_catalog.regprocedure,
    'public.get_following_posts_page(uuid,integer,timestamptz,uuid,uuid,uuid[],text,text)'::pg_catalog.regprocedure
  ]
  LOOP
    SELECT function_row.prosrc
    INTO STRICT v_source
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_signature
      AND function_row.proowner = v_postgres
      AND function_row.prosecdef;

    IF v_signature =
      'public.can_actor_read_post_id(uuid,uuid)'::pg_catalog.regprocedure
      AND (
        pg_catalog.strpos(v_source, 'public.can_actor_read_post_fields(') = 0
        OR pg_catalog.strpos(v_source, 'root.original_post_id IS NULL') = 0
      )
    THEN
      RAISE EXCEPTION 'canonical wrapper/root post reader drifted';
    ELSIF v_signature =
      'public.can_service_actor_read_post(uuid,uuid)'::pg_catalog.regprocedure
      AND pg_catalog.strpos(v_source, 'public.can_actor_read_post_id(') = 0
    THEN
      RAISE EXCEPTION 'service post reader no longer composes canonical reader';
    ELSIF v_signature =
      'public.get_following_posts_page(uuid,integer,timestamptz,uuid,uuid,uuid[],text,text)'::pg_catalog.regprocedure
      AND (
        pg_catalog.strpos(v_source, 'public.can_actor_read_post_fields(') = 0
        OR pg_catalog.strpos(v_source, 'root.original_post_id IS NULL') = 0
      )
    THEN
      RAISE EXCEPTION 'following post page no longer composes wrapper/root reader';
    END IF;
  END LOOP;

  -- Reuse the current mainline identity guard. It serializes author/root
  -- identity before any later post trigger; this migration adds group audience
  -- immutability without replacing that established authorization primitive.
  SELECT function_row.prosrc
  INTO STRICT v_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid =
      'public.guard_post_authorization_identity()'::pg_catalog.regprocedure
    AND function_row.proowner = v_postgres
    AND function_row.prorettype = 'trigger'::pg_catalog.regtype
    AND function_row.prosecdef
    AND function_row.provolatile = 'v'
    AND function_row.prokind = 'f'
    AND function_row.proconfig =
      ARRAY['search_path=pg_catalog, pg_temp']::text[];

  IF pg_catalog.strpos(
      v_source,
      'NEW.author_id IS DISTINCT FROM OLD.author_id'
    ) = 0
    OR pg_catalog.strpos(
      v_source,
      'NEW.original_post_id IS DISTINCT FROM OLD.original_post_id'
    ) = 0
    OR NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_trigger AS trigger_row
      WHERE trigger_row.tgrelid = 'public.posts'::pg_catalog.regclass
        AND trigger_row.tgname =
          'trg_posts_00_guard_authorization_identity'
        AND trigger_row.tgfoid =
          'public.guard_post_authorization_identity()'::pg_catalog.regprocedure
        AND trigger_row.tgenabled = 'O'
        AND NOT trigger_row.tgisinternal
        AND trigger_row.tgtype = 19
        AND trigger_row.tgnargs = 0
        AND pg_catalog.cardinality(trigger_row.tgattr::smallint[]) = 2
        AND trigger_row.tgattr::smallint[] @> ARRAY[
          (
            SELECT attribute.attnum
            FROM pg_catalog.pg_attribute AS attribute
            WHERE attribute.attrelid = 'public.posts'::pg_catalog.regclass
              AND attribute.attname = 'author_id'
          ),
          (
            SELECT attribute.attnum
            FROM pg_catalog.pg_attribute AS attribute
            WHERE attribute.attrelid = 'public.posts'::pg_catalog.regclass
              AND attribute.attname = 'original_post_id'
          )
        ]::smallint[]
        AND trigger_row.tgqual IS NULL
    )
    OR (
      SELECT pg_catalog.count(*)
      FROM pg_catalog.pg_trigger AS trigger_row
      WHERE trigger_row.tgfoid =
          'public.guard_post_authorization_identity()'::pg_catalog.regprocedure
        AND NOT trigger_row.tgisinternal
    ) <> 1
  THEN
    RAISE EXCEPTION 'canonical post authorization identity guard drifted';
  END IF;
END
$preflight$;

LOCK TABLE
  public.groups,
  public.user_profiles,
  public.subscriptions,
  public.group_subscriptions,
  public.group_members,
  public.group_bans,
  public.group_join_requests,
  public.group_invites,
  public.group_invite_redemptions,
  public.group_audit_log,
  public.posts
IN ACCESS EXCLUSIVE MODE;

CREATE OR REPLACE FUNCTION public.has_current_global_pro_entitlement(
  p_actor_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT p_actor_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.user_profiles AS active_profile
      WHERE active_profile.id = p_actor_id
        AND active_profile.deleted_at IS NULL
        AND active_profile.banned_at IS NULL
        AND NOT (
          COALESCE(active_profile.is_banned, false)
          AND (
            active_profile.ban_expires_at IS NULL
            OR active_profile.ban_expires_at
              > pg_catalog.statement_timestamp()
          )
        )
    )
    AND (
      EXISTS (
        SELECT 1
        FROM public.subscriptions AS subscription
        WHERE subscription.user_id = p_actor_id
          AND subscription.status IN ('active', 'trialing')
          AND COALESCE(subscription.tier, subscription.plan) = 'pro'
          AND (
            subscription.current_period_end IS NULL
            OR subscription.current_period_end
              > pg_catalog.statement_timestamp()
          )
      )
      OR EXISTS (
        SELECT 1
        FROM public.user_profiles AS profile_entitlement
        WHERE profile_entitlement.id = p_actor_id
          AND profile_entitlement.subscription_tier = 'pro'
          AND (
            profile_entitlement.pro_expires_at IS NULL
            OR profile_entitlement.pro_expires_at
              > pg_catalog.statement_timestamp()
          )
      )
    )
$function$;

CREATE OR REPLACE FUNCTION public.has_current_group_entitlement(
  p_actor_id uuid,
  p_group_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT COALESCE((
    SELECT
      NOT COALESCE(target_group.is_premium_only, false)
      OR (
        p_actor_id IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM public.user_profiles AS active_profile
          WHERE active_profile.id = p_actor_id
            AND active_profile.deleted_at IS NULL
            AND active_profile.banned_at IS NULL
            AND NOT (
              COALESCE(active_profile.is_banned, false)
              AND (
                active_profile.ban_expires_at IS NULL
                OR active_profile.ban_expires_at
                  > pg_catalog.statement_timestamp()
              )
            )
        )
        AND (
          target_group.created_by = p_actor_id
          OR EXISTS (
            SELECT 1
            FROM public.group_members AS privileged_member
            WHERE privileged_member.group_id = p_group_id
              AND privileged_member.user_id = p_actor_id
              AND privileged_member.role IN (
                'owner'::public.member_role,
                'admin'::public.member_role
              )
          )
          OR EXISTS (
            SELECT 1
            FROM public.group_subscriptions AS group_pass
            WHERE group_pass.group_id = p_group_id
              AND group_pass.user_id = p_actor_id
              AND group_pass.status IN ('active', 'trialing')
              AND group_pass.expires_at
                > pg_catalog.statement_timestamp()
          )
          OR public.has_current_global_pro_entitlement(p_actor_id)
        )
      )
    FROM public.groups AS target_group
    WHERE target_group.id = p_group_id
  ), false)
$function$;

-- Upgrade the already-canonical audience primitive itself. Every caller that
-- reads post fields (post-id checks, service reads, and following pages) now
-- composes current group entitlement without duplicating audience logic.
CREATE OR REPLACE FUNCTION public.can_actor_read_post_fields(
  p_viewer_id uuid,
  p_author_id uuid,
  p_group_id uuid,
  p_visibility text,
  p_status public.post_status,
  p_deleted_at timestamptz
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  WITH effective_viewer AS (
    SELECT CASE
      WHEN p_viewer_id IS NULL THEN NULL::uuid
      WHEN EXISTS (
        SELECT 1
        FROM public.user_profiles AS current_profile
        WHERE current_profile.id = p_viewer_id
          AND current_profile.banned_at IS NULL
          AND current_profile.deleted_at IS NULL
      ) THEN p_viewer_id
      ELSE NULL::uuid
    END AS id
  )
  SELECT COALESCE(CASE
    WHEN p_author_id IS NULL
      OR p_status IS NULL
      OR p_visibility IS NULL
      OR p_deleted_at IS NOT NULL
      OR p_status NOT IN (
        'active'::public.post_status,
        'locked'::public.post_status
      )
      OR p_visibility NOT IN ('public', 'followers', 'group')
      OR (p_visibility = 'group' AND p_group_id IS NULL)
      OR (
        (SELECT id FROM effective_viewer) IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM public.blocked_users AS block_edge
          WHERE (
            block_edge.blocker_id = (SELECT id FROM effective_viewer)
            AND block_edge.blocked_id = p_author_id
          ) OR (
            block_edge.blocker_id = p_author_id
            AND block_edge.blocked_id = (SELECT id FROM effective_viewer)
          )
        )
      )
      THEN false
    WHEN p_group_id IS NULL THEN
      p_visibility = 'public'
      OR p_author_id = (SELECT id FROM effective_viewer)
      OR (
        p_visibility = 'followers'
        AND EXISTS (
          SELECT 1
          FROM public.user_follows AS follow_edge
          WHERE follow_edge.follower_id = (SELECT id FROM effective_viewer)
            AND follow_edge.following_id = p_author_id
        )
      )
    ELSE
      public.has_current_group_entitlement(
        (SELECT id FROM effective_viewer),
        p_group_id
      )
      AND EXISTS (
        SELECT 1
        FROM public.groups AS post_group
        WHERE post_group.id = p_group_id
          AND NOT EXISTS (
            SELECT 1
            FROM public.group_bans AS active_ban
            WHERE active_ban.group_id = p_group_id
              AND active_ban.user_id = (SELECT id FROM effective_viewer)
          )
          AND (
            p_author_id = (SELECT id FROM effective_viewer)
            OR (
              (
                post_group.visibility = 'open'::public.group_visibility
                OR EXISTS (
                  SELECT 1
                  FROM public.group_members AS visible_member
                  WHERE visible_member.group_id = p_group_id
                    AND visible_member.user_id = (SELECT id FROM effective_viewer)
                )
              )
              AND (
                p_visibility = 'public'
                OR (
                  p_visibility = 'followers'
                  AND EXISTS (
                    SELECT 1
                    FROM public.user_follows AS group_follow_edge
                    WHERE group_follow_edge.follower_id =
                        (SELECT id FROM effective_viewer)
                      AND group_follow_edge.following_id = p_author_id
                  )
                )
                OR (
                  p_visibility = 'group'
                  AND EXISTS (
                    SELECT 1
                    FROM public.group_members AS group_only_member
                    WHERE group_only_member.group_id = p_group_id
                      AND group_only_member.user_id =
                        (SELECT id FROM effective_viewer)
                  )
                )
              )
            )
          )
      )
  END, false)
$function$;

CREATE OR REPLACE FUNCTION public.current_user_can_read_post_with_current_entitlement(
  p_post_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT public.can_actor_read_post_id(p_post_id, (SELECT auth.uid()))
$function$;

CREATE OR REPLACE FUNCTION public.current_user_has_current_group_entitlement(
  p_group_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT public.has_current_group_entitlement((SELECT auth.uid()), p_group_id)
$function$;

CREATE OR REPLACE FUNCTION public.service_actor_has_current_group_entitlement(
  p_actor_id uuid,
  p_group_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  RETURN public.has_current_group_entitlement(p_actor_id, p_group_id);
END
$function$;

CREATE OR REPLACE FUNCTION public.service_actor_has_current_global_pro_entitlement(
  p_actor_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  RETURN public.has_current_global_pro_entitlement(p_actor_id);
END
$function$;

-- RLS does not constrain the admin client used by post routes. Enforce the
-- same current membership/account/entitlement contract in a table trigger so
-- service_role and every future trusted writer cross the database boundary.
-- DELETE and updates limited to counters or moderation state remain available.
CREATE OR REPLACE FUNCTION public.enforce_current_group_post_publish()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_actor_id uuid;
  v_group_id uuid;
  v_muted_until timestamptz;
  v_now constant timestamptz := pg_catalog.statement_timestamp();
BEGIN
  IF TG_TABLE_SCHEMA IS DISTINCT FROM 'public'
    OR TG_TABLE_NAME IS DISTINCT FROM 'posts'
    OR TG_OP NOT IN ('INSERT', 'UPDATE')
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'current group post publish guard is misattached';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.author_id IS DISTINCT FROM OLD.author_id
      OR NEW.group_id IS DISTINCT FROM OLD.group_id
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'post author and group audience are immutable';
    END IF;

    -- Do not turn entitlement expiry into an operational outage for counters,
    -- soft deletion, moderation, ranking, or other background-only fields.
    IF NEW.title IS NOT DISTINCT FROM OLD.title
      AND NEW.content IS NOT DISTINCT FROM OLD.content
      AND NEW.visibility IS NOT DISTINCT FROM OLD.visibility
      AND NEW.poll_enabled IS NOT DISTINCT FROM OLD.poll_enabled
      AND NEW.images IS NOT DISTINCT FROM OLD.images
      AND NEW.is_sensitive IS NOT DISTINCT FROM OLD.is_sensitive
      AND NEW.content_warning IS NOT DISTINCT FROM OLD.content_warning
    THEN
      RETURN NEW;
    END IF;

    -- Identity is immutable above, so UPDATE authorization deliberately uses
    -- the retained row's author and audience rather than caller-supplied data.
    v_actor_id := OLD.author_id;
    v_group_id := OLD.group_id;
  ELSE
    v_actor_id := NEW.author_id;
    v_group_id := NEW.group_id;
  END IF;

  IF v_group_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'post author is required for group publication';
  END IF;
  IF NEW.visibility IS DISTINCT FROM 'group' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'group posts must retain group visibility';
  END IF;

  -- This is the same first lock used by atomic pass activation and membership
  -- entry points. A pass cannot cross this publication decision concurrently.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'group-membership:' || v_group_id::text || ':' || v_actor_id::text,
      0
    )
  );

  PERFORM 1
  FROM public.user_profiles AS profile
  WHERE profile.id = v_actor_id
    AND profile.deleted_at IS NULL
    AND profile.banned_at IS NULL
    AND NOT (
      COALESCE(profile.is_banned, false)
      AND (
        profile.ban_expires_at IS NULL
        OR profile.ban_expires_at > v_now
      )
    )
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'account is unavailable for group publication';
  END IF;

  PERFORM 1
  FROM public.groups AS target_group
  WHERE target_group.id = v_group_id
    AND target_group.dissolved_at IS NULL
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'group is unavailable for publication';
  END IF;

  SELECT member.muted_until
  INTO v_muted_until
  FROM public.group_members AS member
  WHERE member.group_id = v_group_id
    AND member.user_id = v_actor_id
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'group membership is required for publication';
  END IF;
  IF v_muted_until IS NOT NULL AND v_muted_until > v_now THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'muted users cannot publish in this group';
  END IF;

  PERFORM 1
  FROM public.group_bans AS active_ban
  WHERE active_ban.group_id = v_group_id
    AND active_ban.user_id = v_actor_id
  FOR SHARE;
  IF FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'banned users cannot publish in this group';
  END IF;

  PERFORM 1
  FROM public.group_subscriptions AS group_pass
  WHERE group_pass.group_id = v_group_id
    AND group_pass.user_id = v_actor_id
    AND group_pass.status IN ('active', 'trialing')
  FOR SHARE;

  PERFORM 1
  FROM public.subscriptions AS global_subscription
  WHERE global_subscription.user_id = v_actor_id
  FOR SHARE;

  IF NOT public.has_current_group_entitlement(v_actor_id, v_group_id) THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'current group entitlement is required for publication';
  END IF;

  RETURN NEW;
END
$function$;

ALTER FUNCTION public.has_current_global_pro_entitlement(uuid)
  OWNER TO postgres;
ALTER FUNCTION public.has_current_group_entitlement(uuid, uuid)
  OWNER TO postgres;
ALTER FUNCTION public.can_actor_read_post_fields(
  uuid, uuid, uuid, text, public.post_status, timestamptz
) OWNER TO postgres;
ALTER FUNCTION public.current_user_can_read_post_with_current_entitlement(uuid)
  OWNER TO postgres;
ALTER FUNCTION public.current_user_has_current_group_entitlement(uuid)
  OWNER TO postgres;
ALTER FUNCTION public.service_actor_has_current_group_entitlement(uuid, uuid)
  OWNER TO postgres;
ALTER FUNCTION public.service_actor_has_current_global_pro_entitlement(uuid)
  OWNER TO postgres;
ALTER FUNCTION public.enforce_current_group_post_publish()
  OWNER TO postgres;

DROP TRIGGER IF EXISTS trg_posts_15_current_group_publish ON public.posts;
CREATE TRIGGER trg_posts_15_current_group_publish
BEFORE INSERT OR UPDATE
ON public.posts
FOR EACH ROW
EXECUTE FUNCTION public.enforce_current_group_post_publish();

-- Forward-port only the premium predicate inside the four current entry
-- points. Every other line of their latest mainline implementation remains
-- byte-for-byte represented by pg_get_functiondef; unexpected source fails
-- closed instead of replacing a newer implementation.
DO $patch_membership_entry_points$
DECLARE
  v_signature pg_catalog.regprocedure;
  v_source text;
  v_definition text;
  v_old_expression constant text :=
    'COALESCE(v_profile.subscription_tier, ''free'') <> ''pro''';
  v_new_expression constant text :=
    'NOT public.has_current_group_entitlement(p_actor_id, p_group_id)';
BEGIN
  FOREACH v_signature IN ARRAY ARRAY[
    'public.mutate_group_membership_atomic(uuid,uuid,text,boolean)'::pg_catalog.regprocedure,
    'public.redeem_group_invite_atomic(uuid,uuid,text,boolean)'::pg_catalog.regprocedure,
    'public.mutate_group_join_request_atomic(uuid,uuid,text,text,boolean)'::pg_catalog.regprocedure,
    'public.inspect_group_invite_atomic(uuid,uuid,text,boolean)'::pg_catalog.regprocedure
  ]
  LOOP
    SELECT function_row.prosrc,
           pg_catalog.pg_get_functiondef(function_row.oid)
    INTO STRICT v_source, v_definition
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_signature;

    IF pg_catalog.strpos(v_source, v_new_expression) > 0 THEN
      CONTINUE;
    END IF;
    IF pg_catalog.strpos(v_source, v_old_expression) = 0 THEN
      RAISE EXCEPTION 'membership entry-point source changed under lock: %',
        v_signature;
    END IF;
    IF pg_catalog.strpos(
      pg_catalog.replace(v_source, v_old_expression, ''),
      v_old_expression
    ) > 0 THEN
      RAISE EXCEPTION 'membership entry-point predicate is not singular: %',
        v_signature;
    END IF;

    v_definition := pg_catalog.replace(
      v_definition,
      v_old_expression,
      v_new_expression
    );
    EXECUTE v_definition;
  END LOOP;
END
$patch_membership_entry_points$;

ALTER FUNCTION public.mutate_group_membership_atomic(
  uuid, uuid, text, boolean
) OWNER TO postgres;
ALTER FUNCTION public.redeem_group_invite_atomic(
  uuid, uuid, text, boolean
) OWNER TO postgres;
ALTER FUNCTION public.mutate_group_join_request_atomic(
  uuid, uuid, text, text, boolean
) OWNER TO postgres;
ALTER FUNCTION public.inspect_group_invite_atomic(
  uuid, uuid, text, boolean
) OWNER TO postgres;

ALTER TABLE public.posts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS posts_group_premium_read_entitlement ON public.posts;
CREATE POLICY posts_group_premium_read_entitlement
  ON public.posts
  AS RESTRICTIVE
  FOR SELECT
  TO anon, authenticated
  USING (public.current_user_can_read_post_with_current_entitlement(id));

DROP POLICY IF EXISTS posts_group_premium_insert_entitlement ON public.posts;
CREATE POLICY posts_group_premium_insert_entitlement
  ON public.posts
  AS RESTRICTIVE
  FOR INSERT
  TO authenticated
  WITH CHECK (
    group_id IS NULL
    OR public.current_user_has_current_group_entitlement(group_id)
  );

DROP POLICY IF EXISTS posts_group_premium_update_entitlement ON public.posts;
CREATE POLICY posts_group_premium_update_entitlement
  ON public.posts
  AS RESTRICTIVE
  FOR UPDATE
  TO authenticated
  USING (
    group_id IS NULL
    OR public.current_user_has_current_group_entitlement(group_id)
  )
  WITH CHECK (
    group_id IS NULL
    OR public.current_user_has_current_group_entitlement(group_id)
  );

DO $converge_function_authority$
DECLARE
  v_signature pg_catalog.regprocedure;
  v_owner oid;
  v_grantee record;
BEGIN
  FOREACH v_signature IN ARRAY ARRAY[
    'public.guard_post_authorization_identity()'::pg_catalog.regprocedure,
    'public.enforce_current_group_post_publish()'::pg_catalog.regprocedure,
    'public.has_current_global_pro_entitlement(uuid)'::pg_catalog.regprocedure,
    'public.has_current_group_entitlement(uuid,uuid)'::pg_catalog.regprocedure,
    'public.can_actor_read_post_fields(uuid,uuid,uuid,text,public.post_status,timestamptz)'::pg_catalog.regprocedure,
    'public.can_actor_read_post_id(uuid,uuid)'::pg_catalog.regprocedure,
    'public.current_user_has_current_group_entitlement(uuid)'::pg_catalog.regprocedure,
    'public.current_user_can_read_post_with_current_entitlement(uuid)'::pg_catalog.regprocedure,
    'public.service_actor_has_current_group_entitlement(uuid,uuid)'::pg_catalog.regprocedure,
    'public.service_actor_has_current_global_pro_entitlement(uuid)'::pg_catalog.regprocedure,
    'public.can_service_actor_read_post(uuid,uuid)'::pg_catalog.regprocedure,
    'public.get_following_posts_page(uuid,integer,timestamptz,uuid,uuid,uuid[],text,text)'::pg_catalog.regprocedure,
    'public.mutate_group_membership_atomic(uuid,uuid,text,boolean)'::pg_catalog.regprocedure,
    'public.redeem_group_invite_atomic(uuid,uuid,text,boolean)'::pg_catalog.regprocedure,
    'public.mutate_group_join_request_atomic(uuid,uuid,text,text,boolean)'::pg_catalog.regprocedure,
    'public.inspect_group_invite_atomic(uuid,uuid,text,boolean)'::pg_catalog.regprocedure
  ]
  LOOP
    SELECT function_row.proowner
    INTO STRICT v_owner
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_signature;

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
      WHERE function_row.oid = v_signature
        AND acl_entry.grantee <> v_owner
    LOOP
      IF v_grantee.grantee = 0 THEN
        EXECUTE pg_catalog.format(
          'REVOKE ALL PRIVILEGES ON FUNCTION %s FROM PUBLIC CASCADE',
          v_signature
        );
      ELSIF v_grantee.rolname IS NOT NULL THEN
        EXECUTE pg_catalog.format(
          'REVOKE ALL PRIVILEGES ON FUNCTION %s FROM %I CASCADE',
          v_signature,
          v_grantee.rolname
        );
      END IF;
    END LOOP;
  END LOOP;
END
$converge_function_authority$;

GRANT EXECUTE ON FUNCTION public.current_user_has_current_group_entitlement(uuid)
  TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.current_user_can_read_post_with_current_entitlement(uuid)
  TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.service_actor_has_current_group_entitlement(
  uuid, uuid
) TO service_role;
GRANT EXECUTE ON FUNCTION public.service_actor_has_current_global_pro_entitlement(uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.can_service_actor_read_post(uuid, uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.get_following_posts_page(
  uuid, integer, timestamptz, uuid, uuid, uuid[], text, text
) TO service_role;
GRANT EXECUTE ON FUNCTION public.mutate_group_membership_atomic(
  uuid, uuid, text, boolean
) TO service_role;
GRANT EXECUTE ON FUNCTION public.redeem_group_invite_atomic(
  uuid, uuid, text, boolean
) TO service_role;
GRANT EXECUTE ON FUNCTION public.mutate_group_join_request_atomic(
  uuid, uuid, text, text, boolean
) TO service_role;
GRANT EXECUTE ON FUNCTION public.inspect_group_invite_atomic(
  uuid, uuid, text, boolean
) TO service_role;

DO $postflight$
DECLARE
  v_postgres oid := (
    SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'postgres'
  );
  v_anon oid := (
    SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'anon'
  );
  v_authenticated oid := (
    SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'authenticated'
  );
  v_service oid := (
    SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'service_role'
  );
  v_authenticator oid := (
    SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'authenticator'
  );
  v_signature pg_catalog.regprocedure;
  v_source text;
  v_author_attnum smallint;
  v_root_attnum smallint;
BEGIN
  SELECT attribute.attnum
  INTO STRICT v_author_attnum
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.posts'::pg_catalog.regclass
    AND attribute.attname = 'author_id';

  SELECT attribute.attnum
  INTO STRICT v_root_attnum
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.posts'::pg_catalog.regclass
    AND attribute.attname = 'original_post_id';

  FOREACH v_signature IN ARRAY ARRAY[
    'public.mutate_group_membership_atomic(uuid,uuid,text,boolean)'::pg_catalog.regprocedure,
    'public.redeem_group_invite_atomic(uuid,uuid,text,boolean)'::pg_catalog.regprocedure,
    'public.mutate_group_join_request_atomic(uuid,uuid,text,text,boolean)'::pg_catalog.regprocedure,
    'public.inspect_group_invite_atomic(uuid,uuid,text,boolean)'::pg_catalog.regprocedure
  ]
  LOOP
    SELECT function_row.prosrc
    INTO STRICT v_source
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_signature
      AND function_row.proowner = v_postgres
      AND function_row.prosecdef;

    IF pg_catalog.strpos(
      v_source,
      'NOT public.has_current_group_entitlement(p_actor_id, p_group_id)'
    ) = 0 OR pg_catalog.strpos(
      v_source,
      'COALESCE(v_profile.subscription_tier, ''free'') <> ''pro'''
    ) > 0 OR pg_catalog.strpos(
      pg_catalog.replace(
        v_source,
        'NOT public.has_current_group_entitlement(p_actor_id, p_group_id)',
        ''
      ),
      'NOT public.has_current_group_entitlement(p_actor_id, p_group_id)'
    ) > 0 THEN
      RAISE EXCEPTION 'membership entry point did not converge: %', v_signature;
    END IF;
  END LOOP;

  FOREACH v_signature IN ARRAY ARRAY[
    'public.has_current_global_pro_entitlement(uuid)'::pg_catalog.regprocedure,
    'public.has_current_group_entitlement(uuid,uuid)'::pg_catalog.regprocedure,
    'public.can_actor_read_post_fields(uuid,uuid,uuid,text,public.post_status,timestamptz)'::pg_catalog.regprocedure,
    'public.can_actor_read_post_id(uuid,uuid)'::pg_catalog.regprocedure,
    'public.current_user_has_current_group_entitlement(uuid)'::pg_catalog.regprocedure,
    'public.current_user_can_read_post_with_current_entitlement(uuid)'::pg_catalog.regprocedure,
    'public.service_actor_has_current_group_entitlement(uuid,uuid)'::pg_catalog.regprocedure,
    'public.service_actor_has_current_global_pro_entitlement(uuid)'::pg_catalog.regprocedure,
    'public.can_service_actor_read_post(uuid,uuid)'::pg_catalog.regprocedure
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS function_row
      WHERE function_row.oid = v_signature
        AND function_row.proowner = v_postgres
        AND function_row.prorettype = 'boolean'::pg_catalog.regtype
        AND function_row.prosecdef
        AND function_row.provolatile = 's'
        AND function_row.prokind = 'f'
        AND function_row.proconfig =
          ARRAY['search_path=pg_catalog, pg_temp']::text[]
    ) THEN
      RAISE EXCEPTION 'premium entitlement helper contract drifted: %',
        v_signature;
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid =
        'public.get_following_posts_page(uuid,integer,timestamptz,uuid,uuid,uuid[],text,text)'::pg_catalog.regprocedure
      AND function_row.proowner = v_postgres
      AND function_row.prorettype = 'jsonb'::pg_catalog.regtype
      AND function_row.prosecdef
      AND function_row.provolatile = 's'
      AND function_row.prokind = 'f'
      AND function_row.proconfig =
        ARRAY['search_path=pg_catalog, pg_temp']::text[]
  ) THEN
    RAISE EXCEPTION 'following post page function contract drifted';
  END IF;

  FOREACH v_signature IN ARRAY ARRAY[
    'public.guard_post_authorization_identity()'::pg_catalog.regprocedure,
    'public.enforce_current_group_post_publish()'::pg_catalog.regprocedure
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS function_row
      WHERE function_row.oid = v_signature
        AND function_row.proowner = v_postgres
        AND function_row.prorettype = 'trigger'::pg_catalog.regtype
        AND function_row.prosecdef
        AND function_row.provolatile = 'v'
        AND function_row.prokind = 'f'
        AND function_row.proconfig =
          ARRAY['search_path=pg_catalog, pg_temp']::text[]
    ) THEN
      RAISE EXCEPTION 'group post publish trigger function drifted: %',
        v_signature;
    END IF;
  END LOOP;

  FOREACH v_signature IN ARRAY ARRAY[
    'public.guard_post_authorization_identity()'::pg_catalog.regprocedure,
    'public.enforce_current_group_post_publish()'::pg_catalog.regprocedure,
    'public.has_current_global_pro_entitlement(uuid)'::pg_catalog.regprocedure,
    'public.has_current_group_entitlement(uuid,uuid)'::pg_catalog.regprocedure,
    'public.can_actor_read_post_fields(uuid,uuid,uuid,text,public.post_status,timestamptz)'::pg_catalog.regprocedure,
    'public.can_actor_read_post_id(uuid,uuid)'::pg_catalog.regprocedure,
    'public.current_user_has_current_group_entitlement(uuid)'::pg_catalog.regprocedure,
    'public.current_user_can_read_post_with_current_entitlement(uuid)'::pg_catalog.regprocedure,
    'public.service_actor_has_current_group_entitlement(uuid,uuid)'::pg_catalog.regprocedure,
    'public.service_actor_has_current_global_pro_entitlement(uuid)'::pg_catalog.regprocedure,
    'public.can_service_actor_read_post(uuid,uuid)'::pg_catalog.regprocedure,
    'public.get_following_posts_page(uuid,integer,timestamptz,uuid,uuid,uuid[],text,text)'::pg_catalog.regprocedure,
    'public.mutate_group_membership_atomic(uuid,uuid,text,boolean)'::pg_catalog.regprocedure,
    'public.redeem_group_invite_atomic(uuid,uuid,text,boolean)'::pg_catalog.regprocedure,
    'public.mutate_group_join_request_atomic(uuid,uuid,text,text,boolean)'::pg_catalog.regprocedure,
    'public.inspect_group_invite_atomic(uuid,uuid,text,boolean)'::pg_catalog.regprocedure
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS function_row
      WHERE function_row.oid = v_signature
        AND function_row.proowner = v_postgres
        AND function_row.prosecdef
    ) THEN
      RAISE EXCEPTION 'premium entitlement function owner drifted: %', v_signature;
    END IF;
  END LOOP;

  IF pg_catalog.has_function_privilege(
    'anon', 'public.has_current_group_entitlement(uuid,uuid)', 'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'authenticated', 'public.has_current_group_entitlement(uuid,uuid)', 'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'anon', 'public.has_current_global_pro_entitlement(uuid)', 'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'authenticated', 'public.has_current_global_pro_entitlement(uuid)', 'EXECUTE'
  ) OR NOT pg_catalog.has_function_privilege(
    'anon',
    'public.current_user_has_current_group_entitlement(uuid)',
    'EXECUTE'
  ) OR NOT pg_catalog.has_function_privilege(
    'authenticated',
    'public.current_user_has_current_group_entitlement(uuid)',
    'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'anon',
    'public.service_actor_has_current_group_entitlement(uuid,uuid)',
    'EXECUTE'
  ) OR NOT pg_catalog.has_function_privilege(
    'service_role',
    'public.service_actor_has_current_group_entitlement(uuid,uuid)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'premium entitlement function ACL drifted';
  END IF;

  IF EXISTS (
    WITH expected(
      function_oid,
      grantee,
      grantor,
      privilege_type,
      is_grantable
    ) AS (
      VALUES
        (
          'public.current_user_has_current_group_entitlement(uuid)'::pg_catalog.regprocedure::oid,
          v_anon,
          v_postgres,
          'EXECUTE'::text,
          false
        ),
        (
          'public.current_user_has_current_group_entitlement(uuid)'::pg_catalog.regprocedure::oid,
          v_authenticated,
          v_postgres,
          'EXECUTE'::text,
          false
        ),
        (
          'public.current_user_can_read_post_with_current_entitlement(uuid)'::pg_catalog.regprocedure::oid,
          v_anon,
          v_postgres,
          'EXECUTE'::text,
          false
        ),
        (
          'public.current_user_can_read_post_with_current_entitlement(uuid)'::pg_catalog.regprocedure::oid,
          v_authenticated,
          v_postgres,
          'EXECUTE'::text,
          false
        ),
        (
          'public.service_actor_has_current_group_entitlement(uuid,uuid)'::pg_catalog.regprocedure::oid,
          v_service,
          v_postgres,
          'EXECUTE'::text,
          false
        ),
        (
          'public.service_actor_has_current_global_pro_entitlement(uuid)'::pg_catalog.regprocedure::oid,
          v_service,
          v_postgres,
          'EXECUTE'::text,
          false
        ),
        (
          'public.can_service_actor_read_post(uuid,uuid)'::pg_catalog.regprocedure::oid,
          v_service,
          v_postgres,
          'EXECUTE'::text,
          false
        ),
        (
          'public.get_following_posts_page(uuid,integer,timestamptz,uuid,uuid,uuid[],text,text)'::pg_catalog.regprocedure::oid,
          v_service,
          v_postgres,
          'EXECUTE'::text,
          false
        ),
        (
          'public.mutate_group_membership_atomic(uuid,uuid,text,boolean)'::pg_catalog.regprocedure::oid,
          v_service,
          v_postgres,
          'EXECUTE'::text,
          false
        ),
        (
          'public.redeem_group_invite_atomic(uuid,uuid,text,boolean)'::pg_catalog.regprocedure::oid,
          v_service,
          v_postgres,
          'EXECUTE'::text,
          false
        ),
        (
          'public.mutate_group_join_request_atomic(uuid,uuid,text,text,boolean)'::pg_catalog.regprocedure::oid,
          v_service,
          v_postgres,
          'EXECUTE'::text,
          false
        ),
        (
          'public.inspect_group_invite_atomic(uuid,uuid,text,boolean)'::pg_catalog.regprocedure::oid,
          v_service,
          v_postgres,
          'EXECUTE'::text,
          false
        )
    ),
    actual AS (
      SELECT
        function_row.oid AS function_oid,
        acl_entry.grantee,
        acl_entry.grantor,
        acl_entry.privilege_type::text,
        acl_entry.is_grantable
      FROM pg_catalog.pg_proc AS function_row
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          function_row.proacl,
          pg_catalog.acldefault('f', function_row.proowner)
        )
      ) AS acl_entry
      WHERE function_row.oid IN (
        'public.guard_post_authorization_identity()'::pg_catalog.regprocedure,
        'public.enforce_current_group_post_publish()'::pg_catalog.regprocedure,
        'public.has_current_global_pro_entitlement(uuid)'::pg_catalog.regprocedure,
        'public.has_current_group_entitlement(uuid,uuid)'::pg_catalog.regprocedure,
        'public.can_actor_read_post_fields(uuid,uuid,uuid,text,public.post_status,timestamptz)'::pg_catalog.regprocedure,
        'public.can_actor_read_post_id(uuid,uuid)'::pg_catalog.regprocedure,
        'public.current_user_has_current_group_entitlement(uuid)'::pg_catalog.regprocedure,
        'public.current_user_can_read_post_with_current_entitlement(uuid)'::pg_catalog.regprocedure,
        'public.service_actor_has_current_group_entitlement(uuid,uuid)'::pg_catalog.regprocedure,
        'public.service_actor_has_current_global_pro_entitlement(uuid)'::pg_catalog.regprocedure,
        'public.can_service_actor_read_post(uuid,uuid)'::pg_catalog.regprocedure,
        'public.get_following_posts_page(uuid,integer,timestamptz,uuid,uuid,uuid[],text,text)'::pg_catalog.regprocedure,
        'public.mutate_group_membership_atomic(uuid,uuid,text,boolean)'::pg_catalog.regprocedure,
        'public.redeem_group_invite_atomic(uuid,uuid,text,boolean)'::pg_catalog.regprocedure,
        'public.mutate_group_join_request_atomic(uuid,uuid,text,text,boolean)'::pg_catalog.regprocedure,
        'public.inspect_group_invite_atomic(uuid,uuid,text,boolean)'::pg_catalog.regprocedure
      )
        AND acl_entry.grantee <> function_row.proowner
    )
    SELECT 1
    FROM expected
    FULL JOIN actual USING (
      function_oid,
      grantee,
      grantor,
      privilege_type,
      is_grantable
    )
    WHERE expected.function_oid IS NULL OR actual.function_oid IS NULL
  ) THEN
    RAISE EXCEPTION 'premium entitlement function ACL is not exact';
  END IF;

  SELECT function_row.prosrc
  INTO STRICT v_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid =
    'public.can_actor_read_post_fields(uuid,uuid,uuid,text,public.post_status,timestamptz)'::pg_catalog.regprocedure;
  IF (
    pg_catalog.char_length(v_source)
    - pg_catalog.char_length(pg_catalog.replace(
      v_source,
      'public.has_current_group_entitlement(',
      ''
    ))
  ) / pg_catalog.char_length('public.has_current_group_entitlement(') <> 1 THEN
    RAISE EXCEPTION 'post field reader current entitlement composition drifted';
  END IF;

  SELECT function_row.prosrc
  INTO STRICT v_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid =
    'public.can_actor_read_post_id(uuid,uuid)'::pg_catalog.regprocedure;
  IF (
    pg_catalog.char_length(v_source)
    - pg_catalog.char_length(pg_catalog.replace(
      v_source,
      'public.can_actor_read_post_fields(',
      ''
    ))
  ) / pg_catalog.char_length('public.can_actor_read_post_fields(') <> 2
    OR pg_catalog.strpos(v_source, 'root.original_post_id IS NULL') = 0
  THEN
    RAISE EXCEPTION 'post-id wrapper/root composition drifted';
  END IF;

  SELECT function_row.prosrc
  INTO STRICT v_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid =
    'public.can_service_actor_read_post(uuid,uuid)'::pg_catalog.regprocedure;
  IF pg_catalog.strpos(v_source, 'public.can_actor_read_post_id(') = 0 THEN
    RAISE EXCEPTION 'service post reader composition drifted';
  END IF;

  SELECT function_row.prosrc
  INTO STRICT v_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid =
    'public.get_following_posts_page(uuid,integer,timestamptz,uuid,uuid,uuid[],text,text)'::pg_catalog.regprocedure;
  IF (
    pg_catalog.char_length(v_source)
    - pg_catalog.char_length(pg_catalog.replace(
      v_source,
      'public.can_actor_read_post_fields(',
      ''
    ))
  ) / pg_catalog.char_length('public.can_actor_read_post_fields(') <> 2
    OR pg_catalog.strpos(v_source, 'root.original_post_id IS NULL') = 0
  THEN
    RAISE EXCEPTION 'following wrapper/root entitlement composition drifted';
  END IF;

  SELECT function_row.prosrc
  INTO STRICT v_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid =
    'public.guard_post_authorization_identity()'::pg_catalog.regprocedure;
  IF pg_catalog.strpos(
      v_source,
      'NEW.author_id IS DISTINCT FROM OLD.author_id'
    ) = 0
    OR pg_catalog.strpos(
      v_source,
      'NEW.original_post_id IS DISTINCT FROM OLD.original_post_id'
    ) = 0
  THEN
    RAISE EXCEPTION 'post authorization identity source drifted';
  END IF;

  SELECT function_row.prosrc
  INTO STRICT v_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid =
    'public.enforce_current_group_post_publish()'::pg_catalog.regprocedure;
  IF pg_catalog.strpos(
      v_source,
      'NEW.author_id IS DISTINCT FROM OLD.author_id'
    ) = 0
    OR pg_catalog.strpos(
      v_source,
      'NEW.group_id IS DISTINCT FROM OLD.group_id'
    ) = 0
    OR pg_catalog.strpos(v_source, 'v_actor_id := OLD.author_id') = 0
    OR pg_catalog.strpos(v_source, 'v_group_id := OLD.group_id') = 0
    OR pg_catalog.strpos(v_source, 'NEW.title IS NOT DISTINCT FROM OLD.title') = 0
    OR pg_catalog.strpos(v_source, 'NEW.content IS NOT DISTINCT FROM OLD.content') = 0
    OR pg_catalog.strpos(v_source, 'NEW.visibility IS NOT DISTINCT FROM OLD.visibility') = 0
    OR pg_catalog.strpos(v_source, 'NEW.poll_enabled IS NOT DISTINCT FROM OLD.poll_enabled') = 0
    OR pg_catalog.strpos(v_source, 'NEW.images IS NOT DISTINCT FROM OLD.images') = 0
    OR pg_catalog.strpos(v_source, 'NEW.is_sensitive IS NOT DISTINCT FROM OLD.is_sensitive') = 0
    OR pg_catalog.strpos(v_source, 'NEW.content_warning IS NOT DISTINCT FROM OLD.content_warning') = 0
    OR pg_catalog.strpos(v_source, 'pg_catalog.pg_advisory_xact_lock') = 0
    OR pg_catalog.strpos(v_source, '''group-membership:''') = 0
    OR pg_catalog.strpos(v_source, 'FROM public.user_profiles') = 0
    OR pg_catalog.strpos(v_source, 'FROM public.groups') = 0
    OR pg_catalog.strpos(v_source, 'FROM public.group_members') = 0
    OR pg_catalog.strpos(v_source, 'FROM public.group_bans') = 0
    OR pg_catalog.strpos(v_source, 'FROM public.group_subscriptions') = 0
    OR pg_catalog.strpos(v_source, 'FROM public.subscriptions') = 0
    OR pg_catalog.strpos(v_source, 'FOR SHARE') = 0
    OR (
      pg_catalog.char_length(v_source)
      - pg_catalog.char_length(pg_catalog.replace(
        v_source,
        'public.has_current_group_entitlement(v_actor_id, v_group_id)',
        ''
      ))
    ) / pg_catalog.char_length(
      'public.has_current_group_entitlement(v_actor_id, v_group_id)'
    ) <> 1
  THEN
    RAISE EXCEPTION 'current group post publish source drifted';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.posts'::pg_catalog.regclass
      AND trigger_row.tgname = 'trg_posts_00_guard_authorization_identity'
      AND trigger_row.tgfoid =
        'public.guard_post_authorization_identity()'::pg_catalog.regprocedure
      AND trigger_row.tgenabled = 'O'
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgtype = 19
      AND trigger_row.tgnargs = 0
      AND pg_catalog.cardinality(trigger_row.tgattr::smallint[]) = 2
      AND trigger_row.tgattr::smallint[] @>
        ARRAY[v_author_attnum, v_root_attnum]::smallint[]
      AND trigger_row.tgqual IS NULL
  ) OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgfoid =
        'public.guard_post_authorization_identity()'::pg_catalog.regprocedure
      AND NOT trigger_row.tgisinternal
  ) <> 1 OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.posts'::pg_catalog.regclass
      AND trigger_row.tgname = 'trg_posts_15_current_group_publish'
      AND trigger_row.tgfoid =
        'public.enforce_current_group_post_publish()'::pg_catalog.regprocedure
      AND trigger_row.tgenabled = 'O'
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgtype = 23
      AND trigger_row.tgnargs = 0
      AND pg_catalog.cardinality(trigger_row.tgattr::smallint[]) = 0
      AND trigger_row.tgqual IS NULL
  ) OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgfoid =
        'public.enforce_current_group_post_publish()'::pg_catalog.regprocedure
      AND NOT trigger_row.tgisinternal
  ) <> 1
  THEN
    RAISE EXCEPTION 'group post publish trigger contract drifted';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.posts'::pg_catalog.regclass
      AND policy.polname IN (
        'posts_group_premium_read_entitlement',
        'posts_group_premium_insert_entitlement',
        'posts_group_premium_update_entitlement'
      )
      AND NOT policy.polpermissive
  ) <> 3 OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.posts'::pg_catalog.regclass
      AND policy.polname = 'posts_group_premium_read_entitlement'
      AND NOT policy.polpermissive
      AND policy.polcmd = 'r'
      AND (
        SELECT pg_catalog.array_agg(role_oid ORDER BY role_oid)
        FROM pg_catalog.unnest(policy.polroles) AS role_oid
      ) = ARRAY[
        LEAST(v_anon, v_authenticated),
        GREATEST(v_anon, v_authenticated)
      ]::oid[]
      AND policy.polqual IS NOT NULL
      AND policy.polwithcheck IS NULL
      AND pg_catalog.strpos(
        pg_catalog.pg_get_expr(policy.polqual, policy.polrelid, true),
        'current_user_can_read_post_with_current_entitlement(id)'
      ) > 0
      AND pg_catalog.strpos(
        pg_catalog.pg_get_expr(policy.polqual, policy.polrelid, true),
        'author_id'
      ) = 0
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.posts'::pg_catalog.regclass
      AND policy.polname = 'posts_group_premium_insert_entitlement'
      AND NOT policy.polpermissive
      AND policy.polcmd = 'a'
      AND policy.polroles = ARRAY[v_authenticated]::oid[]
      AND policy.polqual IS NULL
      AND policy.polwithcheck IS NOT NULL
      AND pg_catalog.strpos(
        pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid, true),
        'group_id IS NULL'
      ) > 0
      AND pg_catalog.strpos(
        pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid, true),
        'current_user_has_current_group_entitlement(group_id)'
      ) > 0
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.posts'::pg_catalog.regclass
      AND policy.polname = 'posts_group_premium_update_entitlement'
      AND NOT policy.polpermissive
      AND policy.polcmd = 'w'
      AND policy.polroles = ARRAY[v_authenticated]::oid[]
      AND policy.polqual IS NOT NULL
      AND policy.polwithcheck IS NOT NULL
      AND pg_catalog.strpos(
        pg_catalog.pg_get_expr(policy.polqual, policy.polrelid, true),
        'current_user_has_current_group_entitlement(group_id)'
      ) > 0
      AND pg_catalog.strpos(
        pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid, true),
        'current_user_has_current_group_entitlement(group_id)'
      ) > 0
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = 'public.posts'::pg_catalog.regclass
      AND relation.relrowsecurity
  ) THEN
    RAISE EXCEPTION 'premium group post RLS contract drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        function_row.proacl,
        pg_catalog.acldefault('f', function_row.proowner)
      )
    ) AS acl_entry
    WHERE function_row.oid IN (
      'public.guard_post_authorization_identity()'::pg_catalog.regprocedure,
      'public.enforce_current_group_post_publish()'::pg_catalog.regprocedure,
      'public.has_current_global_pro_entitlement(uuid)'::pg_catalog.regprocedure,
      'public.has_current_group_entitlement(uuid,uuid)'::pg_catalog.regprocedure,
      'public.can_actor_read_post_fields(uuid,uuid,uuid,text,public.post_status,timestamptz)'::pg_catalog.regprocedure,
      'public.can_actor_read_post_id(uuid,uuid)'::pg_catalog.regprocedure
    )
      AND acl_entry.privilege_type = 'EXECUTE'
      AND acl_entry.grantee <> function_row.proowner
  ) THEN
    RAISE EXCEPTION 'private premium entitlement helper is externally executable';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_auth_members AS membership
    WHERE membership.roleid = v_service
      AND membership.member = v_authenticator
      AND NOT membership.admin_option
      AND NOT membership.inherit_option
      AND membership.set_option
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_auth_members AS membership
    WHERE membership.roleid = v_service
      AND membership.member NOT IN (v_authenticator, v_postgres)
  ) OR EXISTS (
    WITH RECURSIVE service_inheritors(member_oid) AS (
      SELECT membership.member
      FROM pg_catalog.pg_auth_members AS membership
      WHERE membership.roleid = v_service
        AND membership.inherit_option
      UNION
      SELECT membership.member
      FROM pg_catalog.pg_auth_members AS membership
      JOIN service_inheritors AS inherited
        ON membership.roleid = inherited.member_oid
      WHERE membership.inherit_option OR membership.set_option
    )
    SELECT 1
    FROM service_inheritors AS inherited
    JOIN pg_catalog.pg_roles AS role_row
      ON role_row.oid = inherited.member_oid
    WHERE inherited.member_oid <> v_postgres
      AND NOT (
        role_row.rolname = 'cli_login_postgres'
        AND role_row.rolcanlogin
        AND NOT role_row.rolinherit
        AND NOT role_row.rolcreaterole
        AND NOT role_row.rolcreatedb
        AND NOT role_row.rolreplication
        AND NOT role_row.rolbypassrls
        AND NOT role_row.rolsuper
        AND EXISTS (
          SELECT 1
          FROM pg_catalog.pg_auth_members AS managed_membership
          WHERE managed_membership.roleid = v_postgres
            AND managed_membership.member = role_row.oid
            AND NOT managed_membership.admin_option
            AND NOT managed_membership.inherit_option
            AND managed_membership.set_option
        )
      )
  ) OR EXISTS (
    WITH RECURSIVE service_inherits(role_oid) AS (
      SELECT membership.roleid
      FROM pg_catalog.pg_auth_members AS membership
      WHERE membership.member = v_service
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
    SELECT 1
    FROM browser_authority AS inherited
    WHERE inherited.role_oid IN (v_service, v_postgres)
  ) THEN
    RAISE EXCEPTION 'group premium entitlement service-role seal drifted';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
