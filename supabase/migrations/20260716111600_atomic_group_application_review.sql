-- Make ordinary group applications and approval a transactional authority
-- boundary. The legacy approval route claimed, created, linked and compensated
-- across five separate HTTP/PostgREST transactions.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '90s';

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('group-application-authority-migrations', 0)
);

-- Fail before changing authority if the production baseline is older than the
-- schema this focused boundary was built against. These objects all predate
-- the production migration ledger's current 20260716103000 high-water mark.
DO $required_schema$
DECLARE
  required_relation text;
  required_column record;
BEGIN
  FOREACH required_relation IN ARRAY ARRAY[
    'public.user_profiles',
    'public.subscriptions',
    'public.groups',
    'public.group_members',
    'public.group_applications',
    'public.group_audit_log'
  ]
  LOOP
    IF pg_catalog.to_regclass(required_relation) IS NULL THEN
      RAISE EXCEPTION 'required relation is missing: %', required_relation;
    END IF;
  END LOOP;

  FOR required_column IN
    SELECT requirement.relation_name, requirement.column_name
    FROM (
      VALUES
        ('user_profiles', 'id'),
        ('user_profiles', 'deleted_at'),
        ('user_profiles', 'banned_at'),
        ('user_profiles', 'is_banned'),
        ('user_profiles', 'ban_expires_at'),
        ('user_profiles', 'role'),
        ('user_profiles', 'subscription_tier'),
        ('user_profiles', 'pro_expires_at'),
        ('subscriptions', 'user_id'),
        ('subscriptions', 'status'),
        ('subscriptions', 'tier'),
        ('subscriptions', 'plan'),
        ('subscriptions', 'current_period_end'),
        ('groups', 'id'),
        ('groups', 'name'),
        ('groups', 'name_en'),
        ('groups', 'description'),
        ('groups', 'description_en'),
        ('groups', 'avatar_url'),
        ('groups', 'slug'),
        ('groups', 'created_by'),
        ('groups', 'role_names'),
        ('groups', 'rules_json'),
        ('groups', 'rules'),
        ('groups', 'is_premium_only'),
        ('group_members', 'group_id'),
        ('group_members', 'user_id'),
        ('group_members', 'role'),
        ('group_applications', 'id'),
        ('group_applications', 'applicant_id'),
        ('group_applications', 'name'),
        ('group_applications', 'name_en'),
        ('group_applications', 'description'),
        ('group_applications', 'description_en'),
        ('group_applications', 'avatar_url'),
        ('group_applications', 'role_names'),
        ('group_applications', 'rules_json'),
        ('group_applications', 'rules'),
        ('group_applications', 'is_premium_only'),
        ('group_applications', 'status'),
        ('group_applications', 'reject_reason'),
        ('group_applications', 'group_id'),
        ('group_applications', 'reviewed_at'),
        ('group_applications', 'reviewed_by'),
        ('group_applications', 'created_at'),
        ('group_audit_log', 'group_id'),
        ('group_audit_log', 'actor_id'),
        ('group_audit_log', 'action'),
        ('group_audit_log', 'target_id'),
        ('group_audit_log', 'details')
    ) AS requirement(relation_name, column_name)
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_attribute AS attribute
      WHERE attribute.attrelid = pg_catalog.to_regclass(
          'public.' || required_column.relation_name
        )
        AND attribute.attname = required_column.column_name
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
    ) THEN
      RAISE EXCEPTION 'required column is missing: public.%.%',
        required_column.relation_name,
        required_column.column_name;
    END IF;
  END LOOP;

  IF pg_catalog.to_regtype('public.member_role') IS NULL
    OR NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_enum AS enum_value
      WHERE enum_value.enumtypid = 'public.member_role'::regtype
        AND enum_value.enumlabel = 'owner'
    )
  THEN
    RAISE EXCEPTION 'member_role owner enum value is missing';
  END IF;

  -- Require the exact production partial predicates (`column IS NOT NULL`),
  -- key expressions and btree state; a same-named decoy is not a backstop.
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS index_relation
    JOIN pg_catalog.pg_namespace AS index_namespace
      ON index_namespace.oid = index_relation.relnamespace
    JOIN pg_catalog.pg_index AS index_info
      ON index_info.indexrelid = index_relation.oid
    JOIN pg_catalog.pg_class AS table_relation
      ON table_relation.oid = index_info.indrelid
    JOIN pg_catalog.pg_am AS access_method
      ON access_method.oid = index_relation.relam
    WHERE index_namespace.nspname = 'public'
      AND index_relation.relname = 'groups_name_lower_unique'
      AND index_relation.relkind = 'i'
      AND table_relation.oid = 'public.groups'::regclass
      AND access_method.amname = 'btree'
      AND index_info.indisunique
      AND index_info.indisvalid
      AND index_info.indisready
      AND index_info.indislive
      AND NOT index_info.indisprimary
      AND NOT index_info.indisexclusion
      AND NOT index_info.indnullsnotdistinct
      AND index_info.indnkeyatts = 1
      AND index_info.indnatts = 1
      AND index_info.indkey = '0'::int2vector
      AND pg_catalog.pg_get_indexdef(index_relation.oid, 1, true) = 'lower(name)'
      AND pg_catalog.pg_get_expr(index_info.indpred, index_info.indrelid, true)
        = 'name IS NOT NULL'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS index_relation
    JOIN pg_catalog.pg_namespace AS index_namespace
      ON index_namespace.oid = index_relation.relnamespace
    JOIN pg_catalog.pg_index AS index_info
      ON index_info.indexrelid = index_relation.oid
    JOIN pg_catalog.pg_class AS table_relation
      ON table_relation.oid = index_info.indrelid
    JOIN pg_catalog.pg_am AS access_method
      ON access_method.oid = index_relation.relam
    JOIN pg_catalog.pg_attribute AS slug_attribute
      ON slug_attribute.attrelid = table_relation.oid
      AND slug_attribute.attname = 'slug'
      AND slug_attribute.attnum > 0
      AND NOT slug_attribute.attisdropped
    WHERE index_namespace.nspname = 'public'
      AND index_relation.relname = 'groups_slug_key'
      AND index_relation.relkind = 'i'
      AND table_relation.oid = 'public.groups'::regclass
      AND access_method.amname = 'btree'
      AND index_info.indisunique
      AND index_info.indisvalid
      AND index_info.indisready
      AND index_info.indislive
      AND NOT index_info.indisprimary
      AND NOT index_info.indisexclusion
      AND NOT index_info.indnullsnotdistinct
      AND index_info.indnkeyatts = 1
      AND index_info.indnatts = 1
      AND index_info.indexprs IS NULL
      AND index_info.indkey[0] = slug_attribute.attnum
      AND pg_catalog.pg_get_indexdef(index_relation.oid, 1, true) = 'slug'
      AND pg_catalog.pg_get_expr(index_info.indpred, index_info.indrelid, true)
        = 'slug IS NOT NULL'
  ) THEN
    RAISE EXCEPTION 'required unique group-name/slug index definitions are invalid';
  END IF;
END
$required_schema$;

-- Remove the two pre-promotion overloads. CREATE OR REPLACE with the new
-- defaulted trailing argument creates a distinct signature and would otherwise
-- leave the old SECURITY DEFINER entry point callable in parallel.
DROP FUNCTION IF EXISTS public.submit_group_application_atomic(
  uuid, text, text, text, text, text, jsonb, jsonb, text, boolean
);
DROP FUNCTION IF EXISTS public.review_group_application_atomic(
  uuid, uuid, text, text
);

-- Keep premium application eligibility self-contained. The earlier combined
-- lockdown also defines this predicate, but this focused migration must apply
-- safely on a mainline which has not taken that cross-domain migration.
CREATE OR REPLACE FUNCTION public.has_current_global_pro_entitlement(
  p_actor_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $entitlement$
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
            OR active_profile.ban_expires_at > pg_catalog.statement_timestamp()
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
            OR subscription.current_period_end > pg_catalog.statement_timestamp()
          )
      )
      OR EXISTS (
        SELECT 1
        FROM public.user_profiles AS profile_entitlement
        WHERE profile_entitlement.id = p_actor_id
          AND profile_entitlement.subscription_tier = 'pro'
          AND (
            profile_entitlement.pro_expires_at IS NULL
            OR profile_entitlement.pro_expires_at > pg_catalog.statement_timestamp()
          )
      )
    )
$entitlement$;

ALTER FUNCTION public.has_current_global_pro_entitlement(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.has_current_global_pro_entitlement(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.submit_group_application_atomic(
  p_actor_id uuid,
  p_name text,
  p_name_en text DEFAULT NULL,
  p_description text DEFAULT NULL,
  p_description_en text DEFAULT NULL,
  p_avatar_url text DEFAULT NULL,
  p_role_names jsonb DEFAULT NULL,
  p_rules_json jsonb DEFAULT NULL,
  p_rules text DEFAULT NULL,
  p_is_premium_only boolean DEFAULT false,
  p_promo_unlocked boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_name text := normalize(pg_catalog.btrim(COALESCE(p_name, '')), NFC);
  v_application_id uuid;
  v_created_at timestamptz;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_actor_id IS NULL
    OR v_name = ''
    OR pg_catalog.char_length(v_name) > 50
    OR pg_catalog.char_length(COALESCE(p_name_en, '')) > 50
    OR pg_catalog.char_length(COALESCE(p_description, '')) > 500
    OR pg_catalog.char_length(COALESCE(p_description_en, '')) > 500
    OR pg_catalog.char_length(COALESCE(p_avatar_url, '')) > 2048
    OR pg_catalog.char_length(COALESCE(p_rules, '')) > 10000
    OR pg_catalog.pg_column_size(COALESCE(p_role_names, '{}'::jsonb)) > 32768
    OR pg_catalog.pg_column_size(COALESCE(p_rules_json, '[]'::jsonb)) > 65536
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('group-application-actor:' || p_actor_id::text, 0)
  );

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

  IF COALESCE(p_is_premium_only, false)
    AND NOT COALESCE(p_promo_unlocked, false)
    AND NOT public.has_current_global_pro_entitlement(p_actor_id)
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'pro_required');
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.group_applications AS pending_application
    WHERE pending_application.applicant_id = p_actor_id
      AND pending_application.status = 'pending'
  ) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'pending_exists');
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('group-name:' || pg_catalog.lower(v_name), 0)
  );
  IF EXISTS (
    SELECT 1
    FROM public.groups AS existing_group
    WHERE pg_catalog.lower(normalize(existing_group.name, NFC))
      = pg_catalog.lower(v_name)
  ) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'name_taken');
  END IF;

  INSERT INTO public.group_applications (
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
    p_actor_id,
    v_name,
    NULLIF(pg_catalog.btrim(COALESCE(p_name_en, '')), ''),
    NULLIF(pg_catalog.btrim(COALESCE(p_description, '')), ''),
    NULLIF(pg_catalog.btrim(COALESCE(p_description_en, '')), ''),
    NULLIF(pg_catalog.btrim(COALESCE(p_avatar_url, '')), ''),
    p_role_names,
    p_rules_json,
    NULLIF(pg_catalog.btrim(COALESCE(p_rules, '')), ''),
    COALESCE(p_is_premium_only, false),
    'pending'
  )
  RETURNING id, created_at INTO v_application_id, v_created_at;

  RETURN pg_catalog.jsonb_build_object(
    'status', 'submitted',
    'application_id', v_application_id,
    'created_at', v_created_at
  );
END
$function$;

ALTER FUNCTION public.submit_group_application_atomic(
  uuid, text, text, text, text, text, jsonb, jsonb, text, boolean, boolean
) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.submit_group_application_atomic(
  uuid, text, text, text, text, text, jsonb, jsonb, text, boolean, boolean
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.submit_group_application_atomic(
  uuid, text, text, text, text, text, jsonb, jsonb, text, boolean, boolean
) TO service_role;

CREATE OR REPLACE FUNCTION public.review_group_application_atomic(
  p_reviewer_id uuid,
  p_application_id uuid,
  p_decision text,
  p_reject_reason text DEFAULT NULL,
  p_promo_unlocked boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_application public.group_applications%ROWTYPE;
  v_group_id uuid;
  v_slug_base text;
  v_slug text;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_reviewer_id IS NULL
    OR p_application_id IS NULL
    OR p_decision IS NULL
    OR p_decision NOT IN ('approve', 'reject')
    OR pg_catalog.char_length(COALESCE(p_reject_reason, '')) > 500
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;

  SELECT application.*
  INTO v_application
  FROM public.group_applications AS application
  WHERE application.id = p_application_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;
  IF v_application.status <> 'pending' THEN
    RETURN pg_catalog.jsonb_build_object('status', 'already_processed');
  END IF;

  -- Lock both authority-bearing profiles in a deterministic UUID order. The
  -- former reviewer -> application -> applicant order deadlocked when two
  -- admins reviewed each other's applications concurrently.
  PERFORM profile.id
  FROM public.user_profiles AS profile
  WHERE profile.id = ANY(ARRAY[p_reviewer_id, v_application.applicant_id])
  ORDER BY profile.id
  FOR UPDATE;

  IF NOT EXISTS (
    SELECT 1
    FROM public.user_profiles AS reviewer
    WHERE reviewer.id = p_reviewer_id
      AND reviewer.role = 'admin'
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
    RETURN pg_catalog.jsonb_build_object('status', 'reviewer_unauthorized');
  END IF;

  IF p_decision = 'reject' THEN
    UPDATE public.group_applications
    SET status = 'rejected',
        reject_reason = NULLIF(pg_catalog.btrim(COALESCE(p_reject_reason, '')), ''),
        reviewed_at = pg_catalog.clock_timestamp(),
        reviewed_by = p_reviewer_id
    WHERE id = p_application_id;

    RETURN pg_catalog.jsonb_build_object(
      'status', 'rejected',
      'application_id', v_application.id,
      'applicant_id', v_application.applicant_id,
      'group_name', v_application.name,
      'reject_reason', NULLIF(pg_catalog.btrim(COALESCE(p_reject_reason, '')), '')
    );
  END IF;

  IF pg_catalog.btrim(COALESCE(v_application.name, '')) = ''
    OR pg_catalog.char_length(normalize(pg_catalog.btrim(v_application.name), NFC)) > 50
    OR pg_catalog.char_length(COALESCE(v_application.name_en, '')) > 50
    OR pg_catalog.char_length(COALESCE(v_application.description, '')) > 500
    OR pg_catalog.char_length(COALESCE(v_application.description_en, '')) > 500
    OR pg_catalog.char_length(COALESCE(v_application.avatar_url, '')) > 2048
    OR pg_catalog.char_length(COALESCE(v_application.rules, '')) > 10000
    OR pg_catalog.pg_column_size(COALESCE(v_application.role_names, '{}'::jsonb)) > 32768
    OR pg_catalog.pg_column_size(COALESCE(v_application.rules_json, '[]'::jsonb)) > 65536
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.user_profiles AS applicant
    WHERE applicant.id = v_application.applicant_id
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

  IF COALESCE(v_application.is_premium_only, false)
    AND NOT COALESCE(p_promo_unlocked, false)
    AND NOT public.has_current_global_pro_entitlement(v_application.applicant_id)
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'pro_required');
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'group-name:' || pg_catalog.lower(normalize(v_application.name, NFC)),
      0
    )
  );
  IF EXISTS (
    SELECT 1
    FROM public.groups AS existing_group
    WHERE pg_catalog.lower(normalize(existing_group.name, NFC))
      = pg_catalog.lower(normalize(v_application.name, NFC))
  ) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'name_taken');
  END IF;

  v_group_id := gen_random_uuid();
  v_slug_base := pg_catalog.btrim(
    pg_catalog.regexp_replace(pg_catalog.lower(v_application.name), '[^a-z0-9]+', '-', 'g'),
    '-'
  );
  IF v_slug_base = '' THEN
    v_slug_base := 'group';
  END IF;
  v_slug := pg_catalog.left(v_slug_base, 80) || '-' || v_application.id::text;

  INSERT INTO public.groups (
    id,
    name,
    name_en,
    description,
    description_en,
    avatar_url,
    slug,
    created_by,
    role_names,
    rules_json,
    rules,
    is_premium_only
  ) VALUES (
    v_group_id,
    normalize(pg_catalog.btrim(v_application.name), NFC),
    v_application.name_en,
    v_application.description,
    v_application.description_en,
    v_application.avatar_url,
    v_slug,
    v_application.applicant_id,
    v_application.role_names,
    v_application.rules_json,
    v_application.rules,
    COALESCE(v_application.is_premium_only, false)
  );

  INSERT INTO public.group_members (group_id, user_id, role)
  VALUES (v_group_id, v_application.applicant_id, 'owner'::public.member_role);

  UPDATE public.group_applications
  SET status = 'approved',
      reject_reason = NULL,
      reviewed_at = pg_catalog.clock_timestamp(),
      reviewed_by = p_reviewer_id,
      group_id = v_group_id
  WHERE id = p_application_id;

  INSERT INTO public.group_audit_log (
    group_id,
    actor_id,
    action,
    target_id,
    details
  ) VALUES (
    v_group_id,
    p_reviewer_id,
    'application_approved',
    v_application.applicant_id,
    pg_catalog.jsonb_build_object('application_id', v_application.id)
  );

  RETURN pg_catalog.jsonb_build_object(
    'status', 'approved',
    'application_id', v_application.id,
    'applicant_id', v_application.applicant_id,
    'group_id', v_group_id,
    'group_name', v_application.name
  );
END
$function$;

ALTER FUNCTION public.review_group_application_atomic(uuid, uuid, text, text, boolean)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.review_group_application_atomic(uuid, uuid, text, text, boolean)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.review_group_application_atomic(uuid, uuid, text, text, boolean)
  TO service_role;

-- Preserve the canonical routines' OIDs on replay, but remove every other
-- same-named function/procedure so default parameters cannot leave PostgREST
-- with an ambiguous or less-restricted entry point.
DO $drop_noncanonical_group_application_routines$
DECLARE
  routine record;
BEGIN
  FOR routine IN
    SELECT
      function_namespace.nspname,
      procedure.proname,
      pg_catalog.pg_get_function_identity_arguments(procedure.oid) AS identity_arguments
    FROM pg_catalog.pg_proc AS procedure
    JOIN pg_catalog.pg_namespace AS function_namespace
      ON function_namespace.oid = procedure.pronamespace
    WHERE function_namespace.nspname = 'public'
      AND procedure.proname IN (
        'submit_group_application_atomic',
        'review_group_application_atomic'
      )
      AND procedure.prokind IN ('f', 'p')
      AND procedure.oid NOT IN (
        pg_catalog.to_regprocedure(
          'public.submit_group_application_atomic(uuid,text,text,text,text,text,jsonb,jsonb,text,boolean,boolean)'
        ),
        pg_catalog.to_regprocedure(
          'public.review_group_application_atomic(uuid,uuid,text,text,boolean)'
        )
      )
  LOOP
    EXECUTE pg_catalog.format(
      'DROP ROUTINE %I.%I(%s) RESTRICT',
      routine.nspname,
      routine.proname,
      routine.identity_arguments
    );
  END LOOP;
END
$drop_noncanonical_group_application_routines$;

NOTIFY pgrst, 'reload schema';

COMMIT;
