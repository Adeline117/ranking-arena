-- Make regular group membership authorization and member counts transactional.
-- This migration intentionally does not install moderation RPCs: ban/kick/unban
-- are cut over independently so either rollout can be reverted on its own.

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
    'group_members',
    'group_bans',
    'group_invites',
    'group_join_requests',
    'user_profiles'
  ]::text[]
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS relation
      WHERE relation.oid = pg_catalog.to_regclass('public.' || required_relation)
        AND relation.relkind IN ('r', 'p')
        AND pg_catalog.pg_get_userbyid(relation.relowner) = 'postgres'
    ) THEN
      RAISE EXCEPTION 'postgres-owned membership relation is missing: public.%',
        required_relation;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('groups', 'id'),
        ('groups', 'created_by'),
        ('groups', 'visibility'),
        ('groups', 'member_count'),
        ('groups', 'dissolved_at'),
        ('groups', 'is_premium_only'),
        ('groups', 'min_arena_score'),
        ('groups', 'is_verified_only'),
        ('group_members', 'group_id'),
        ('group_members', 'user_id'),
        ('group_members', 'role'),
        ('group_bans', 'group_id'),
        ('group_bans', 'user_id'),
        ('group_invites', 'id'),
        ('group_invites', 'group_id'),
        ('group_invites', 'token_hash'),
        ('group_invites', 'max_uses'),
        ('group_invites', 'used_count'),
        ('group_invites', 'expires_at'),
        ('group_join_requests', 'id'),
        ('group_join_requests', 'group_id'),
        ('group_join_requests', 'user_id'),
        ('group_join_requests', 'status'),
        ('group_join_requests', 'decided_by'),
        ('group_join_requests', 'decided_at'),
        ('group_join_requests', 'created_at'),
        ('user_profiles', 'id'),
        ('user_profiles', 'deleted_at'),
        ('user_profiles', 'banned_at'),
        ('user_profiles', 'is_banned'),
        ('user_profiles', 'ban_expires_at'),
        ('user_profiles', 'subscription_tier'),
        ('user_profiles', 'reputation_score'),
        ('user_profiles', 'is_verified_trader')
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
    RAISE EXCEPTION 'required membership authorization columns are missing';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('groups', 'id', 'uuid'::pg_catalog.regtype),
        ('groups', 'created_by', 'uuid'::pg_catalog.regtype),
        ('groups', 'visibility', 'public.group_visibility'::pg_catalog.regtype),
        ('groups', 'member_count', 'integer'::pg_catalog.regtype),
        ('group_members', 'group_id', 'uuid'::pg_catalog.regtype),
        ('group_members', 'user_id', 'uuid'::pg_catalog.regtype),
        ('group_members', 'role', 'public.member_role'::pg_catalog.regtype),
        ('group_bans', 'group_id', 'uuid'::pg_catalog.regtype),
        ('group_bans', 'user_id', 'uuid'::pg_catalog.regtype),
        ('group_invites', 'id', 'uuid'::pg_catalog.regtype),
        ('group_invites', 'group_id', 'uuid'::pg_catalog.regtype),
        ('group_invites', 'token_hash', 'text'::pg_catalog.regtype),
        ('group_invites', 'max_uses', 'integer'::pg_catalog.regtype),
        ('group_invites', 'used_count', 'integer'::pg_catalog.regtype),
        ('group_invites', 'expires_at', 'timestamptz'::pg_catalog.regtype),
        ('group_join_requests', 'id', 'uuid'::pg_catalog.regtype),
        ('group_join_requests', 'group_id', 'uuid'::pg_catalog.regtype),
        ('group_join_requests', 'user_id', 'uuid'::pg_catalog.regtype),
        ('group_join_requests', 'status', 'text'::pg_catalog.regtype),
        ('group_join_requests', 'decided_by', 'uuid'::pg_catalog.regtype),
        ('group_join_requests', 'decided_at', 'timestamptz'::pg_catalog.regtype),
        ('group_join_requests', 'created_at', 'timestamptz'::pg_catalog.regtype),
        ('user_profiles', 'id', 'uuid'::pg_catalog.regtype),
        ('user_profiles', 'subscription_tier', 'text'::pg_catalog.regtype),
        ('user_profiles', 'reputation_score', 'integer'::pg_catalog.regtype),
        ('user_profiles', 'is_verified_trader', 'boolean'::pg_catalog.regtype)
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
    RAISE EXCEPTION 'membership authorization column types are incompatible';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = 'public.group_join_requests'::pg_catalog.regclass
      AND attribute.attname = 'consumed_at'
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND attribute.atttypid <> 'pg_catalog.timestamptz'::pg_catalog.regtype
  ) THEN
    RAISE EXCEPTION 'public.group_join_requests.consumed_at has an incompatible type';
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

  -- Membership and ban serialization assumes one canonical row per edge.
  -- Check the exact primary-key authority before any DDL/data calibration so a
  -- later moderation migration cannot be the first place malformed edges fail.
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_info
    WHERE constraint_info.conrelid =
        'public.group_members'::pg_catalog.regclass
      AND constraint_info.contype = 'p'
      AND constraint_info.convalidated
      AND NOT constraint_info.condeferrable
      AND NOT constraint_info.condeferred
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
      AND NOT constraint_info.condeferred
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
    RAISE EXCEPTION 'membership edge primary keys are incompatible';
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
      AND enum_value.enumlabel = 'member'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_enum AS enum_value
    WHERE enum_value.enumtypid = 'public.group_visibility'::pg_catalog.regtype
      AND enum_value.enumlabel = 'open'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_enum AS enum_value
    WHERE enum_value.enumtypid = 'public.group_visibility'::pg_catalog.regtype
      AND enum_value.enumlabel = 'apply'
  ) THEN
    RAISE EXCEPTION 'required membership enum labels are missing';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_info
    WHERE function_info.pronamespace = 'public'::pg_catalog.regnamespace
      AND function_info.proname = 'mutate_group_membership_atomic'
      AND pg_catalog.pg_get_function_identity_arguments(function_info.oid)
        <> 'p_actor_id uuid, p_group_id uuid, p_action text, p_pro_free_promo boolean'
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_info
    WHERE function_info.pronamespace = 'public'::pg_catalog.regnamespace
      AND function_info.proname = 'redeem_group_invite_atomic'
      AND pg_catalog.pg_get_function_identity_arguments(function_info.oid)
        <> 'p_actor_id uuid, p_group_id uuid, p_token_hash text, p_pro_free_promo boolean'
  ) THEN
    RAISE EXCEPTION 'unexpected atomic group membership overload exists';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_info
    WHERE function_info.pronamespace = 'public'::pg_catalog.regnamespace
      AND function_info.proname IN (
        'increment_member_count',
        'decrement_member_count'
      )
      AND pg_catalog.pg_get_userbyid(function_info.proowner) <> 'postgres'
  ) THEN
    RAISE EXCEPTION 'legacy group member counter has an unexpected owner';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_info
    JOIN pg_catalog.pg_proc AS function_info
      ON function_info.oid = trigger_info.tgfoid
    WHERE NOT trigger_info.tgisinternal
      AND function_info.pronamespace = 'public'::pg_catalog.regnamespace
      AND function_info.proname IN (
        'sync_group_member_count',
        'update_group_member_count'
      )
      AND trigger_info.tgrelid <>
        'public.group_members'::pg_catalog.regclass
  ) THEN
    RAISE EXCEPTION 'legacy group count trigger is attached to an unexpected table';
  END IF;
END
$preflight$;

-- The post-lock checks below are deliberate. A clean read-only catalog audit is
-- not authority for rows that may arrive before this migration is deployed.
LOCK TABLE
  public.groups,
  public.user_profiles,
  public.group_members,
  public.group_bans,
  public.group_invites,
  public.group_join_requests
IN ACCESS EXCLUSIVE MODE;

ALTER TABLE public.group_join_requests
  ADD COLUMN IF NOT EXISTS consumed_at timestamptz;

DO $locked_data_preflight$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.group_invites AS invite
    WHERE invite.token_hash IS NULL
      OR invite.group_id IS NULL
      OR invite.max_uses IS NULL
      OR invite.used_count IS NULL
      OR invite.expires_at IS NULL
      OR NOT pg_catalog.isfinite(invite.expires_at)
      OR invite.max_uses <= 0
      OR invite.used_count < 0
      OR invite.used_count > invite.max_uses
      OR invite.token_hash !~ '^[0-9a-f]{64}$'
  ) THEN
    RAISE EXCEPTION 'invalid group invite rows must be repaired explicitly';
  END IF;

  IF EXISTS (
    SELECT invite.token_hash
    FROM public.group_invites AS invite
    GROUP BY invite.token_hash
    HAVING pg_catalog.count(*) > 1
  ) THEN
    RAISE EXCEPTION 'duplicate group invite token hashes require explicit review';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.group_join_requests AS join_request
    WHERE join_request.group_id IS NULL
      OR join_request.user_id IS NULL
      OR join_request.status IS NULL
      OR join_request.status NOT IN (
        'pending', 'approved', 'rejected', 'cancelled', 'joined'
      )
      OR (
        join_request.status = 'pending'
        AND (
          join_request.decided_by IS NOT NULL
          OR join_request.decided_at IS NOT NULL
        )
      )
      OR (
        join_request.status IN ('approved', 'rejected')
        AND (
          join_request.decided_by IS NULL
          OR join_request.decided_at IS NULL
        )
      )
      OR (
        join_request.status = 'joined'
        AND join_request.consumed_at IS NULL
      )
      OR (
        join_request.status <> 'joined'
        AND join_request.consumed_at IS NOT NULL
      )
  ) THEN
    RAISE EXCEPTION 'invalid group join request state requires explicit review';
  END IF;

  IF EXISTS (
    SELECT join_request.group_id, join_request.user_id
    FROM public.group_join_requests AS join_request
    WHERE join_request.status IN ('pending', 'approved')
    GROUP BY join_request.group_id, join_request.user_id
    HAVING pg_catalog.count(*) > 1
  ) THEN
    RAISE EXCEPTION 'duplicate active group join requests require explicit review';
  END IF;

  IF pg_catalog.to_regclass('public.group_invites_token_hash_unique') IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_index AS index_info
      JOIN pg_catalog.pg_class AS index_relation
        ON index_relation.oid = index_info.indexrelid
      JOIN pg_catalog.pg_attribute AS attribute
        ON attribute.attrelid = index_info.indrelid
       AND attribute.attnum = index_info.indkey[0]
      WHERE index_relation.oid =
          pg_catalog.to_regclass('public.group_invites_token_hash_unique')
        AND index_info.indrelid = 'public.group_invites'::pg_catalog.regclass
        AND index_info.indisunique
        AND index_info.indisvalid
        AND index_info.indisready
        AND index_info.indnkeyatts = 1
        AND index_info.indnatts = 1
        AND index_info.indpred IS NULL
        AND index_info.indexprs IS NULL
        AND attribute.attname = 'token_hash'
    )
  THEN
    RAISE EXCEPTION 'group_invites_token_hash_unique is a conflicting index';
  END IF;

  IF pg_catalog.to_regclass('public.group_join_requests_active_edge_unique') IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_index AS index_info
      JOIN pg_catalog.pg_class AS index_relation
        ON index_relation.oid = index_info.indexrelid
      JOIN pg_catalog.pg_attribute AS first_attribute
        ON first_attribute.attrelid = index_info.indrelid
       AND first_attribute.attnum = index_info.indkey[0]
      JOIN pg_catalog.pg_attribute AS second_attribute
        ON second_attribute.attrelid = index_info.indrelid
       AND second_attribute.attnum = index_info.indkey[1]
      WHERE index_relation.oid = pg_catalog.to_regclass(
          'public.group_join_requests_active_edge_unique'
        )
        AND index_info.indrelid = 'public.group_join_requests'::pg_catalog.regclass
        AND index_info.indisunique
        AND index_info.indisvalid
        AND index_info.indisready
        AND index_info.indnkeyatts = 2
        AND index_info.indnatts = 2
        AND index_info.indexprs IS NULL
        AND first_attribute.attname = 'group_id'
        AND second_attribute.attname = 'user_id'
        AND pg_catalog.pg_get_expr(index_info.indpred, index_info.indrelid, true)
          = 'status = ANY (ARRAY[''pending''::text, ''approved''::text])'
    )
  THEN
    RAISE EXCEPTION 'group_join_requests_active_edge_unique is a conflicting index';
  END IF;
END
$locked_data_preflight$;

ALTER TABLE public.group_invites
  ALTER COLUMN group_id SET NOT NULL,
  ALTER COLUMN token_hash SET NOT NULL,
  ALTER COLUMN max_uses SET DEFAULT 50,
  ALTER COLUMN max_uses SET NOT NULL,
  ALTER COLUMN used_count SET DEFAULT 0,
  ALTER COLUMN used_count SET NOT NULL,
  ALTER COLUMN expires_at SET NOT NULL;

ALTER TABLE public.group_invites
  DROP CONSTRAINT IF EXISTS group_invites_usage_valid,
  DROP CONSTRAINT IF EXISTS group_invites_token_hash_format,
  DROP CONSTRAINT IF EXISTS group_invites_expiry_finite;
ALTER TABLE public.group_invites
  ADD CONSTRAINT group_invites_usage_valid
    CHECK (max_uses > 0 AND used_count >= 0 AND used_count <= max_uses),
  ADD CONSTRAINT group_invites_token_hash_format
    CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT group_invites_expiry_finite
    CHECK (pg_catalog.isfinite(expires_at));

ALTER TABLE public.group_join_requests
  ALTER COLUMN group_id SET NOT NULL,
  ALTER COLUMN user_id SET NOT NULL,
  ALTER COLUMN status SET DEFAULT 'pending',
  ALTER COLUMN status SET NOT NULL;
ALTER TABLE public.group_join_requests
  DROP CONSTRAINT IF EXISTS group_join_requests_status_valid,
  DROP CONSTRAINT IF EXISTS group_join_requests_consumption_valid;
ALTER TABLE public.group_join_requests
  ADD CONSTRAINT group_join_requests_status_valid
    CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled', 'joined')),
  ADD CONSTRAINT group_join_requests_consumption_valid
    CHECK (
      (
        status = 'pending'
        AND decided_by IS NULL
        AND decided_at IS NULL
        AND consumed_at IS NULL
      )
      OR (
        status IN ('approved', 'rejected')
        AND decided_by IS NOT NULL
        AND decided_at IS NOT NULL
        AND consumed_at IS NULL
      )
      OR (status = 'cancelled' AND consumed_at IS NULL)
      OR (status = 'joined' AND consumed_at IS NOT NULL)
    );

CREATE UNIQUE INDEX IF NOT EXISTS group_invites_token_hash_unique
  ON public.group_invites (token_hash);
CREATE UNIQUE INDEX IF NOT EXISTS group_join_requests_active_edge_unique
  ON public.group_join_requests (group_id, user_id)
  WHERE status IN ('pending', 'approved');

CREATE TABLE IF NOT EXISTS public.group_invite_redemptions (
  invite_id uuid NOT NULL
    REFERENCES public.group_invites(id) ON DELETE CASCADE,
  group_id uuid NOT NULL
    REFERENCES public.groups(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  redeemed_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  PRIMARY KEY (invite_id, user_id)
);

ALTER TABLE public.group_invite_redemptions OWNER TO postgres;
ALTER TABLE public.group_invite_redemptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.group_invite_redemptions FORCE ROW LEVEL SECURITY;

DO $redemption_shape_preflight$
BEGIN
  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid =
        'public.group_invite_redemptions'::pg_catalog.regclass
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  ) <> 4 OR EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('invite_id', 'uuid'::pg_catalog.regtype),
        ('group_id', 'uuid'::pg_catalog.regtype),
        ('user_id', 'uuid'::pg_catalog.regtype),
        ('redeemed_at', 'timestamptz'::pg_catalog.regtype)
    ) AS required_column(column_name, type_oid)
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_attribute AS attribute
      WHERE attribute.attrelid =
          'public.group_invite_redemptions'::pg_catalog.regclass
        AND attribute.attname = required_column.column_name
        AND attribute.atttypid = required_column.type_oid
        AND attribute.attnotnull
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
    )
  ) OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_attrdef AS default_info
    WHERE default_info.adrelid =
        'public.group_invite_redemptions'::pg_catalog.regclass
  ) <> 1 OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    JOIN pg_catalog.pg_attrdef AS default_info
      ON default_info.adrelid = attribute.attrelid
     AND default_info.adnum = attribute.attnum
    WHERE attribute.attrelid =
        'public.group_invite_redemptions'::pg_catalog.regclass
      AND attribute.attname = 'redeemed_at'
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND pg_catalog.pg_get_expr(
        default_info.adbin,
        default_info.adrelid,
        true
      ) = 'clock_timestamp()'
  ) OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_constraint AS constraint_info
    WHERE constraint_info.conrelid =
        'public.group_invite_redemptions'::pg_catalog.regclass
  ) <> 3 OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_info
    WHERE constraint_info.conrelid =
        'public.group_invite_redemptions'::pg_catalog.regclass
      AND constraint_info.contype = 'p'
      AND constraint_info.convalidated
      AND NOT constraint_info.condeferrable
      AND NOT constraint_info.condeferred
      AND constraint_info.conkey = ARRAY[
        (
          SELECT attribute.attnum
          FROM pg_catalog.pg_attribute AS attribute
          WHERE attribute.attrelid = constraint_info.conrelid
            AND attribute.attname = 'invite_id'
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
    WHERE constraint_info.conrelid =
        'public.group_invite_redemptions'::pg_catalog.regclass
      AND constraint_info.contype = 'f'
      AND constraint_info.convalidated
      AND NOT constraint_info.condeferrable
      AND NOT constraint_info.condeferred
      AND constraint_info.confrelid =
        'public.group_invites'::pg_catalog.regclass
      AND constraint_info.conkey = ARRAY[
        (
          SELECT attribute.attnum
          FROM pg_catalog.pg_attribute AS attribute
          WHERE attribute.attrelid = constraint_info.conrelid
            AND attribute.attname = 'invite_id'
        )
      ]::smallint[]
      AND constraint_info.confkey = ARRAY[
        (
          SELECT attribute.attnum
          FROM pg_catalog.pg_attribute AS attribute
          WHERE attribute.attrelid = constraint_info.confrelid
            AND attribute.attname = 'id'
        )
      ]::smallint[]
      AND constraint_info.confupdtype = 'a'
      AND constraint_info.confdeltype = 'c'
      AND constraint_info.confmatchtype = 's'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_info
    WHERE constraint_info.conrelid =
        'public.group_invite_redemptions'::pg_catalog.regclass
      AND constraint_info.contype = 'f'
      AND constraint_info.convalidated
      AND NOT constraint_info.condeferrable
      AND NOT constraint_info.condeferred
      AND constraint_info.confrelid = 'public.groups'::pg_catalog.regclass
      AND constraint_info.conkey = ARRAY[
        (
          SELECT attribute.attnum
          FROM pg_catalog.pg_attribute AS attribute
          WHERE attribute.attrelid = constraint_info.conrelid
            AND attribute.attname = 'group_id'
        )
      ]::smallint[]
      AND constraint_info.confkey = ARRAY[
        (
          SELECT attribute.attnum
          FROM pg_catalog.pg_attribute AS attribute
          WHERE attribute.attrelid = constraint_info.confrelid
            AND attribute.attname = 'id'
        )
      ]::smallint[]
      AND constraint_info.confupdtype = 'a'
      AND constraint_info.confdeltype = 'c'
      AND constraint_info.confmatchtype = 's'
  ) OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_index AS index_info
    WHERE index_info.indrelid =
        'public.group_invite_redemptions'::pg_catalog.regclass
  ) <> 1 OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_info
    JOIN pg_catalog.pg_index AS index_info
      ON index_info.indexrelid = constraint_info.conindid
    WHERE constraint_info.conrelid =
        'public.group_invite_redemptions'::pg_catalog.regclass
      AND constraint_info.contype = 'p'
      AND index_info.indrelid = constraint_info.conrelid
      AND index_info.indisprimary
      AND index_info.indisunique
      AND index_info.indisvalid
      AND index_info.indisready
      AND index_info.indimmediate
      AND index_info.indnkeyatts = 2
      AND index_info.indnatts = 2
      AND index_info.indpred IS NULL
      AND index_info.indexprs IS NULL
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_info
    WHERE trigger_info.tgrelid =
        'public.group_invite_redemptions'::pg_catalog.regclass
      AND NOT trigger_info.tgisinternal
  ) THEN
    RAISE EXCEPTION 'group_invite_redemptions has an incompatible shape';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.group_invite_redemptions AS redemption
    LEFT JOIN public.group_invites AS invite
      ON invite.id = redemption.invite_id
    WHERE invite.id IS NULL
      OR invite.group_id IS DISTINCT FROM redemption.group_id
  ) THEN
    RAISE EXCEPTION 'group invite redemption evidence has a mismatched group';
  END IF;
END
$redemption_shape_preflight$;

DO $replace_redemption_policies$
DECLARE
  policy_info record;
BEGIN
  FOR policy_info IN
    SELECT policy.polname
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid =
        'public.group_invite_redemptions'::pg_catalog.regclass
  LOOP
    EXECUTE pg_catalog.format(
      'DROP POLICY %I ON public.group_invite_redemptions',
      policy_info.polname
    );
  END LOOP;
END
$replace_redemption_policies$;

DO $converge_redemption_acls$
DECLARE
  relation_oid oid := 'public.group_invite_redemptions'::pg_catalog.regclass;
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
      EXECUTE 'REVOKE ALL PRIVILEGES ON TABLE '
        || 'public.group_invite_redemptions FROM PUBLIC';
    ELSIF grantee_info.rolname IS NOT NULL THEN
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON TABLE '
          || 'public.group_invite_redemptions FROM %I',
        grantee_info.rolname
      );
    END IF;
  END LOOP;

  REVOKE ALL PRIVILEGES ON TABLE public.group_invite_redemptions
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
          || 'ON TABLE public.group_invite_redemptions FROM PUBLIC',
        column_list
      );
    ELSIF grantee_info.rolname IS NOT NULL THEN
      EXECUTE pg_catalog.format(
        'REVOKE SELECT (%1$s), INSERT (%1$s), UPDATE (%1$s), REFERENCES (%1$s) '
          || 'ON TABLE public.group_invite_redemptions FROM %2$I',
        column_list,
        grantee_info.rolname
      );
    END IF;
  END LOOP;
END
$converge_redemption_acls$;

CREATE POLICY internal_owner_mutation
  ON public.group_invite_redemptions
  AS PERMISSIVE
  FOR ALL
  TO postgres
  USING (true)
  WITH CHECK (true);

-- A browser may submit its own pending request under the existing RLS policy,
-- but it must never mint an already-approved credential in the INSERT itself.
-- Administrative approval remains an UPDATE protected by the table's admin RLS.
CREATE OR REPLACE FUNCTION public.enforce_group_join_request_state()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status IS DISTINCT FROM 'pending'
      OR NEW.decided_by IS NOT NULL
      OR NEW.decided_at IS NOT NULL
      OR NEW.consumed_at IS NOT NULL
    THEN
      RAISE EXCEPTION 'new group join requests must start pending'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.group_id IS DISTINCT FROM OLD.group_id
    OR NEW.user_id IS DISTINCT FROM OLD.user_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'group join request identity is immutable'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.status IN ('joined', 'rejected', 'cancelled')
    AND pg_catalog.to_jsonb(NEW) IS DISTINCT FROM pg_catalog.to_jsonb(OLD)
  THEN
    RAISE EXCEPTION 'terminal group join request evidence is immutable'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.status = 'approved'
    AND NEW.status NOT IN ('approved', 'rejected', 'cancelled', 'joined')
  THEN
    RAISE EXCEPTION 'approved group join request cannot return to pending'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$function$;

ALTER FUNCTION public.enforce_group_join_request_state() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.enforce_group_join_request_state()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_group_join_requests_05_enforce_state
  ON public.group_join_requests;
CREATE TRIGGER trg_group_join_requests_05_enforce_state
  BEFORE INSERT OR UPDATE ON public.group_join_requests
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_group_join_request_state();

-- Both legacy counter functions have existed in production. Remove every
-- trigger wired to either implementation before recreating one canonical edge.
DO $drop_legacy_count_triggers$
DECLARE
  trigger_info record;
BEGIN
  FOR trigger_info IN
    SELECT trigger_row.tgname
    FROM pg_catalog.pg_trigger AS trigger_row
    JOIN pg_catalog.pg_proc AS function_info
      ON function_info.oid = trigger_row.tgfoid
    WHERE trigger_row.tgrelid = 'public.group_members'::pg_catalog.regclass
      AND NOT trigger_row.tgisinternal
      AND function_info.pronamespace = 'public'::pg_catalog.regnamespace
      AND function_info.proname IN (
        'sync_group_member_count',
        'update_group_member_count'
      )
  LOOP
    EXECUTE pg_catalog.format(
      'DROP TRIGGER %I ON public.group_members',
      trigger_info.tgname
    );
  END LOOP;
END
$drop_legacy_count_triggers$;

DROP FUNCTION IF EXISTS public.update_group_member_count();

CREATE OR REPLACE FUNCTION public.sync_group_member_count()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE public.groups
    SET member_count = COALESCE(member_count, 0) + 1
    WHERE id = NEW.group_id;
    RETURN NEW;
  END IF;

  UPDATE public.groups
  SET member_count = GREATEST(COALESCE(member_count, 0) - 1, 0)
  WHERE id = OLD.group_id;
  RETURN OLD;
END
$function$;

ALTER FUNCTION public.sync_group_member_count() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sync_group_member_count()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER trg_sync_group_member_count
  AFTER INSERT OR DELETE ON public.group_members
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_group_member_count();

-- Repair every group, including NULL and zero-member rows, before making the
-- cache non-null. No historical row is inferred from the stale cache value.
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

ALTER TABLE public.groups
  ALTER COLUMN member_count SET DEFAULT 0,
  ALTER COLUMN member_count SET NOT NULL;

-- A common advisory lock linearizes all current and future membership/ban edge
-- writes. The join RPC rechecks bans only after acquiring this exact lock.
CREATE OR REPLACE FUNCTION public.serialize_group_membership_edge()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_old_key text;
  v_new_key text;
  v_first_key text;
  v_second_key text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    v_old_key := 'group-membership:' || OLD.group_id::text || ':' || OLD.user_id::text;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    v_new_key := 'group-membership:' || NEW.group_id::text || ':' || NEW.user_id::text;
  END IF;

  IF v_old_key IS NULL OR v_old_key = v_new_key THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(COALESCE(v_new_key, v_old_key), 0)
    );
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF v_new_key IS NULL THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(v_old_key, 0)
    );
    RETURN OLD;
  END IF;

  v_first_key := LEAST(v_old_key, v_new_key);
  v_second_key := GREATEST(v_old_key, v_new_key);
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_first_key, 0)
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_second_key, 0)
  );
  RETURN NEW;
END
$function$;

ALTER FUNCTION public.serialize_group_membership_edge() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.serialize_group_membership_edge()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_group_members_05_serialize_edge ON public.group_members;
CREATE TRIGGER trg_group_members_05_serialize_edge
  BEFORE INSERT OR UPDATE OF group_id, user_id OR DELETE ON public.group_members
  FOR EACH ROW
  EXECUTE FUNCTION public.serialize_group_membership_edge();

DROP TRIGGER IF EXISTS trg_group_bans_05_serialize_edge ON public.group_bans;
CREATE TRIGGER trg_group_bans_05_serialize_edge
  BEFORE INSERT OR UPDATE OF group_id, user_id OR DELETE ON public.group_bans
  FOR EACH ROW
  EXECUTE FUNCTION public.serialize_group_membership_edge();

CREATE OR REPLACE FUNCTION public.mutate_group_membership_atomic(
  p_actor_id uuid,
  p_group_id uuid,
  p_action text,
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
  v_existing_role text;
  v_request_id uuid;
  v_member_count integer;
  v_profile_found boolean := false;
  v_group_found boolean := false;
  v_is_member boolean := false;
  v_is_banned boolean := false;
  v_has_approved_request boolean := false;
  v_deleted_count integer := 0;
  v_consumed_count integer := 0;
  v_visibility text;
BEGIN
  IF p_actor_id IS NULL
    OR p_group_id IS NULL
    OR p_action IS NULL
    OR p_action NOT IN ('join', 'leave')
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
  INTO v_existing_role
  FROM public.group_members AS member
  WHERE member.group_id = p_group_id
    AND member.user_id = p_actor_id
  FOR UPDATE;
  v_is_member := FOUND;

  IF p_action = 'leave' THEN
    IF NOT v_is_member THEN
      RETURN pg_catalog.jsonb_build_object('status', 'not_member');
    END IF;
    IF v_existing_role = 'owner' OR v_group.created_by = p_actor_id THEN
      RETURN pg_catalog.jsonb_build_object('status', 'owner_forbidden');
    END IF;

    DELETE FROM public.group_members AS member
    WHERE member.group_id = p_group_id
      AND member.user_id = p_actor_id;
    GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
    IF v_deleted_count <> 1 THEN
      RAISE EXCEPTION 'atomic group leave deleted % rows', v_deleted_count;
    END IF;

    SELECT target_group.member_count
    INTO v_member_count
    FROM public.groups AS target_group
    WHERE target_group.id = p_group_id;

    RETURN pg_catalog.jsonb_build_object(
      'status', 'left',
      'member_count', v_member_count
    );
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.group_bans AS ban
    WHERE ban.group_id = p_group_id
      AND ban.user_id = p_actor_id
  )
  INTO v_is_banned;
  IF v_is_banned THEN
    RETURN pg_catalog.jsonb_build_object('status', 'banned');
  END IF;

  IF v_is_member THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'already_member',
      'role', v_existing_role,
      'member_count', v_group.member_count
    );
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
  IF v_visibility = 'apply' THEN
    SELECT join_request.id
    INTO v_request_id
    FROM public.group_join_requests AS join_request
    WHERE join_request.group_id = p_group_id
      AND join_request.user_id = p_actor_id
      AND join_request.status = 'approved'
    ORDER BY join_request.decided_at NULLS LAST, join_request.id
    LIMIT 1
    FOR UPDATE;
    v_has_approved_request := FOUND;

    IF NOT v_has_approved_request THEN
      RETURN pg_catalog.jsonb_build_object('status', 'approval_required');
    END IF;
  ELSIF v_visibility IS DISTINCT FROM 'open' THEN
    -- Future private groups and any unknown visibility are invite-only. The
    -- invite RPC handles private without weakening this default-deny branch.
    RETURN pg_catalog.jsonb_build_object('status', 'invite_required');
  END IF;

  INSERT INTO public.group_members (group_id, user_id, role)
  VALUES (
    p_group_id,
    p_actor_id,
    CASE
      WHEN v_group.created_by = p_actor_id THEN 'owner'::public.member_role
      ELSE 'member'::public.member_role
    END
  );

  IF v_visibility = 'apply' THEN
    UPDATE public.group_join_requests AS join_request
    SET status = 'joined',
        consumed_at = pg_catalog.clock_timestamp()
    WHERE join_request.id = v_request_id
      AND join_request.group_id = p_group_id
      AND join_request.user_id = p_actor_id
      AND join_request.status = 'approved';
    GET DIAGNOSTICS v_consumed_count = ROW_COUNT;
    IF v_consumed_count <> 1 THEN
      RAISE EXCEPTION 'approved group join request was not consumed exactly once';
    END IF;
  ELSE
    UPDATE public.group_join_requests AS join_request
    SET status = 'joined',
        consumed_at = pg_catalog.clock_timestamp()
    WHERE join_request.group_id = p_group_id
      AND join_request.user_id = p_actor_id
      AND join_request.status IN ('pending', 'approved');
  END IF;

  SELECT target_group.member_count
  INTO v_member_count
  FROM public.groups AS target_group
  WHERE target_group.id = p_group_id;

  RETURN pg_catalog.jsonb_build_object(
    'status', 'joined',
    'owner_id', v_group.created_by,
    'member_count', v_member_count
  );
END
$function$;

ALTER FUNCTION public.mutate_group_membership_atomic(uuid, uuid, text, boolean)
  OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.redeem_group_invite_atomic(
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
  v_existing_role text;
  v_member_count integer;
  v_new_used_count integer;
  v_invite_found boolean := false;
  v_profile_found boolean := false;
  v_group_found boolean := false;
  v_is_member boolean := false;
  v_is_banned boolean := false;
  v_was_redeemed boolean := false;
  v_updated_count integer := 0;
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
  FOR UPDATE;
  v_invite_found := FOUND;

  IF NOT v_invite_found
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

  v_visibility := v_group.visibility::text;
  IF v_visibility IS NULL
    OR v_visibility NOT IN ('open', 'apply', 'private')
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invite_required');
  END IF;

  SELECT member.role::text
  INTO v_existing_role
  FROM public.group_members AS member
  WHERE member.group_id = p_group_id
    AND member.user_id = p_actor_id
  FOR UPDATE;
  v_is_member := FOUND;

  SELECT EXISTS (
    SELECT 1
    FROM public.group_bans AS ban
    WHERE ban.group_id = p_group_id
      AND ban.user_id = p_actor_id
  )
  INTO v_is_banned;
  IF v_is_banned THEN
    RETURN pg_catalog.jsonb_build_object('status', 'banned');
  END IF;

  IF v_is_member THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'already_member',
      'role', v_existing_role,
      'member_count', v_group.member_count
    );
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

  INSERT INTO public.group_invite_redemptions (
    invite_id,
    group_id,
    user_id
  ) VALUES (
    v_invite.id,
    p_group_id,
    p_actor_id
  );

  INSERT INTO public.group_members (group_id, user_id, role)
  VALUES (
    p_group_id,
    p_actor_id,
    CASE
      WHEN v_group.created_by = p_actor_id THEN 'owner'::public.member_role
      ELSE 'member'::public.member_role
    END
  );

  UPDATE public.group_invites AS invite
  SET used_count = invite.used_count + 1
  WHERE invite.id = v_invite.id
    AND invite.group_id = p_group_id
    AND invite.used_count < invite.max_uses
  RETURNING invite.used_count INTO v_new_used_count;
  GET DIAGNOSTICS v_updated_count = ROW_COUNT;
  IF v_updated_count <> 1 THEN
    RAISE EXCEPTION 'group invite capacity was not consumed exactly once';
  END IF;

  UPDATE public.group_join_requests AS join_request
  SET status = 'joined',
      consumed_at = pg_catalog.clock_timestamp()
  WHERE join_request.group_id = p_group_id
    AND join_request.user_id = p_actor_id
    AND join_request.status IN ('pending', 'approved');

  SELECT target_group.member_count
  INTO v_member_count
  FROM public.groups AS target_group
  WHERE target_group.id = p_group_id;

  RETURN pg_catalog.jsonb_build_object(
    'status', 'joined',
    'owner_id', v_group.created_by,
    'member_count', v_member_count,
    'invite_used_count', v_new_used_count
  );
END
$function$;

ALTER FUNCTION public.redeem_group_invite_atomic(uuid, uuid, text, boolean)
  OWNER TO postgres;

-- CREATE OR REPLACE retains old ACLs. Converge named and arbitrary drifted
-- grantees before granting only the two public entry points to service_role.
DO $converge_function_acls$
DECLARE
  signature pg_catalog.regprocedure;
  function_owner oid;
  grantee_info record;
BEGIN
  FOREACH signature IN ARRAY ARRAY[
    'public.sync_group_member_count()'::pg_catalog.regprocedure,
    'public.serialize_group_membership_edge()'::pg_catalog.regprocedure,
    'public.enforce_group_join_request_state()'::pg_catalog.regprocedure,
    'public.mutate_group_membership_atomic(uuid,uuid,text,boolean)'::pg_catalog.regprocedure,
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

GRANT EXECUTE ON FUNCTION public.mutate_group_membership_atomic(
  uuid, uuid, text, boolean
) TO service_role;
GRANT EXECUTE ON FUNCTION public.redeem_group_invite_atomic(
  uuid, uuid, text, boolean
) TO service_role;

DO $retire_legacy_member_counters$
DECLARE
  signature pg_catalog.regprocedure;
  function_owner oid;
  grantee_info record;
BEGIN
  FOR signature IN
    SELECT function_info.oid::pg_catalog.regprocedure
    FROM pg_catalog.pg_proc AS function_info
    WHERE function_info.pronamespace = 'public'::pg_catalog.regnamespace
      AND function_info.proname IN (
        'increment_member_count',
        'decrement_member_count'
      )
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
$retire_legacy_member_counters$;

DO $postflight$
DECLARE
  rpc_signature pg_catalog.regprocedure;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.groups AS target_group
    WHERE target_group.member_count IS DISTINCT FROM (
      SELECT pg_catalog.count(*)::integer
      FROM public.group_members AS member
      WHERE member.group_id = target_group.id
    )
  ) THEN
    RAISE EXCEPTION 'group member_count calibration failed';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    JOIN pg_catalog.pg_attrdef AS default_info
      ON default_info.adrelid = attribute.attrelid
     AND default_info.adnum = attribute.attnum
    WHERE attribute.attrelid = 'public.groups'::pg_catalog.regclass
      AND attribute.attname = 'member_count'
      AND attribute.attnotnull
      AND pg_catalog.pg_get_expr(
        default_info.adbin,
        default_info.adrelid,
        true
      ) = '0'
  ) THEN
    RAISE EXCEPTION 'groups.member_count default/not-null contract is missing';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_trigger AS trigger_info
    JOIN pg_catalog.pg_proc AS function_info
      ON function_info.oid = trigger_info.tgfoid
    WHERE trigger_info.tgrelid = 'public.group_members'::pg_catalog.regclass
      AND NOT trigger_info.tgisinternal
      AND function_info.pronamespace = 'public'::pg_catalog.regnamespace
      AND function_info.proname IN (
        'sync_group_member_count',
        'update_group_member_count'
      )
  ) <> 1 OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_info
    WHERE trigger_info.tgrelid = 'public.group_members'::pg_catalog.regclass
      AND trigger_info.tgname = 'trg_sync_group_member_count'
      AND trigger_info.tgfoid =
        'public.sync_group_member_count()'::pg_catalog.regprocedure
      AND trigger_info.tgenabled = 'O'
  ) OR pg_catalog.to_regprocedure('public.update_group_member_count()') IS NOT NULL
  OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_info
    JOIN pg_catalog.pg_proc AS function_info
      ON function_info.oid = trigger_info.tgfoid
    WHERE trigger_info.tgrelid = 'public.group_members'::pg_catalog.regclass
      AND NOT trigger_info.tgisinternal
      AND trigger_info.tgname <> 'trg_sync_group_member_count'
      AND pg_catalog.pg_get_functiondef(function_info.oid) ~*
        'update[[:space:]]+(public\.)?groups[[:space:]]+set[[:space:]]+member_count'
  )
  THEN
    RAISE EXCEPTION 'canonical group member count trigger did not converge';
  END IF;

  IF NOT EXISTS (
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
    RAISE EXCEPTION 'membership/ban edge serialization triggers are missing';
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
  ) THEN
    RAISE EXCEPTION 'group join request state trigger is missing';
  END IF;

  IF NOT EXISTS (
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
      AND index_info.indrelid = 'public.group_join_requests'::pg_catalog.regclass
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
    RAISE EXCEPTION 'membership authorization uniqueness is missing';
  END IF;

  FOREACH rpc_signature IN ARRAY ARRAY[
    'public.mutate_group_membership_atomic(uuid,uuid,text,boolean)'::pg_catalog.regprocedure,
    'public.redeem_group_invite_atomic(uuid,uuid,text,boolean)'::pg_catalog.regprocedure
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS function_info
      WHERE function_info.oid = rpc_signature
        AND function_info.prosecdef
        AND pg_catalog.pg_get_userbyid(function_info.proowner) = 'postgres'
        AND function_info.proconfig = ARRAY['search_path=pg_catalog, public']::text[]
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
        AND acl.grantee NOT IN (
          function_info.proowner,
          (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'service_role')
        )
    ) THEN
      RAISE EXCEPTION 'atomic membership RPC ACL/security contract drifted: %',
        rpc_signature;
    END IF;
  END LOOP;

  FOREACH rpc_signature IN ARRAY ARRAY[
    'public.sync_group_member_count()'::pg_catalog.regprocedure,
    'public.serialize_group_membership_edge()'::pg_catalog.regprocedure,
    'public.enforce_group_join_request_state()'::pg_catalog.regprocedure
  ]
  LOOP
    IF pg_catalog.has_function_privilege(
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
        AND acl.grantee <> function_info.proowner
    ) THEN
      RAISE EXCEPTION 'internal membership function remains callable: %',
        rpc_signature;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_info
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        function_info.proacl,
        pg_catalog.acldefault('f', function_info.proowner)
      )
    ) AS acl
    WHERE function_info.pronamespace = 'public'::pg_catalog.regnamespace
      AND function_info.proname IN (
        'increment_member_count',
        'decrement_member_count'
      )
      AND acl.privilege_type = 'EXECUTE'
      AND acl.grantee <> function_info.proowner
  ) THEN
    RAISE EXCEPTION 'legacy member count RPC execute privilege remains';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_info
    WHERE function_info.pronamespace = 'public'::pg_catalog.regnamespace
      AND function_info.proname IN (
        'mutate_group_membership_atomic',
        'redeem_group_invite_atomic'
      )
      AND function_info.oid NOT IN (
        'public.mutate_group_membership_atomic(uuid,uuid,text,boolean)'::pg_catalog.regprocedure,
        'public.redeem_group_invite_atomic(uuid,uuid,text,boolean)'::pg_catalog.regprocedure
      )
  ) THEN
    RAISE EXCEPTION 'unexpected atomic membership overload remains';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = 'public.group_invite_redemptions'::pg_catalog.regclass
      AND relation.relrowsecurity
      AND relation.relforcerowsecurity
      AND pg_catalog.pg_get_userbyid(relation.relowner) = 'postgres'
  ) OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid =
        'public.group_invite_redemptions'::pg_catalog.regclass
  ) <> 1 OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid =
        'public.group_invite_redemptions'::pg_catalog.regclass
      AND policy.polname = 'internal_owner_mutation'
      AND policy.polcmd = '*'
      AND policy.polpermissive
      AND policy.polroles = ARRAY[
        (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'postgres')
      ]::oid[]
      AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid, true) = 'true'
      AND pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid, true) = 'true'
  ) OR pg_catalog.has_table_privilege(
    'service_role',
    'public.group_invite_redemptions',
    'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        relation.relacl,
        pg_catalog.acldefault('r', relation.relowner)
      )
    ) AS acl
    WHERE relation.oid =
        'public.group_invite_redemptions'::pg_catalog.regclass
      AND acl.grantee <> relation.relowner
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl
    WHERE attribute.attrelid =
        'public.group_invite_redemptions'::pg_catalog.regclass
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND acl.grantee <> (
        SELECT relation.relowner
        FROM pg_catalog.pg_class AS relation
        WHERE relation.oid = attribute.attrelid
      )
  ) THEN
    RAISE EXCEPTION 'group invite redemption evidence boundary drifted';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
