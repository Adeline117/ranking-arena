-- Migration: 20260803111000_post_media_claims.sql
-- Created: 2026-08-03T11:10:00Z
-- Description: Add an inert, private, append-only media-claim substrate and
--   opt-in service wrappers that compose existing content authorities with an
--   exact media manifest in one transaction. No current API calls these new
--   names. This migration does not release, lease, admit, delete, garbage
--   collect, or mutate a Storage object.
-- Phase: predeploy.
-- Trusted-DDL boundary: the postgres migration runner and callers honoring the
-- global advisory namespace are the trusted management plane. Existing
-- service/unknown grants and catalog drift fail closed; concurrent superuser
-- DDL that deliberately ignores the migration lock is outside this contract.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';
SET LOCAL search_path = pg_catalog, public, pg_temp;

DO $migration_lock$
BEGIN
  IF NOT pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended('public-post-media-claims@1', 0)
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55P03',
      MESSAGE = 'post media claims migration lock is busy';
  END IF;
END
$migration_lock$;

-- Re-audit the PostgreSQL 17 role graph at this publication boundary. The
-- upload registry's earlier proof is transactional/temporary; a later role
-- membership change must not silently gain these new service authorities.
CREATE OR REPLACE FUNCTION pg_temp.post_media_claim_role_graph_is_safe()
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $function$
  WITH RECURSIVE protected_root AS (
    SELECT
      role_row.oid AS origin_oid,
      role_row.rolname AS origin_name,
      role_row.rolsuper,
      role_row.rolbypassrls
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname IN (
      'anon', 'authenticated', 'authenticator', 'service_role'
    )
  ), membership_path AS (
    SELECT
      protected_root.origin_name,
      membership.roleid AS reachable_oid,
      1 AS depth,
      ARRAY[protected_root.origin_oid, membership.roleid]::oid[] AS visited,
      membership.admin_option,
      membership.inherit_option,
      membership.set_option
    FROM protected_root
    JOIN pg_catalog.pg_auth_members AS membership
      ON membership.member = protected_root.origin_oid

    UNION ALL

    SELECT
      membership_path.origin_name,
      membership.roleid,
      membership_path.depth + 1,
      membership_path.visited || membership.roleid,
      membership.admin_option,
      membership.inherit_option,
      membership.set_option
    FROM membership_path
    JOIN pg_catalog.pg_auth_members AS membership
      ON membership.member = membership_path.reachable_oid
    WHERE NOT membership.roleid = ANY (membership_path.visited)
  ), service_authority AS (
    SELECT membership.member AS member_oid
    FROM pg_catalog.pg_auth_members AS membership
    WHERE membership.roleid = pg_catalog.to_regrole('service_role')
      AND (
        membership.admin_option
        OR membership.inherit_option
        OR membership.set_option
      )

    UNION

    SELECT membership.member
    FROM pg_catalog.pg_auth_members AS membership
    JOIN service_authority AS inherited
      ON membership.roleid = inherited.member_oid
    WHERE membership.admin_option
       OR membership.inherit_option
       OR membership.set_option
  ), service_inherits AS (
    SELECT membership.roleid AS role_oid
    FROM pg_catalog.pg_auth_members AS membership
    WHERE membership.member = pg_catalog.to_regrole('service_role')
      AND (
        membership.admin_option
        OR membership.inherit_option
        OR membership.set_option
      )

    UNION

    SELECT membership.roleid
    FROM pg_catalog.pg_auth_members AS membership
    JOIN service_inherits AS inherited
      ON membership.member = inherited.role_oid
    WHERE membership.admin_option
       OR membership.inherit_option
       OR membership.set_option
  )
  SELECT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_auth_members AS membership
    WHERE membership.roleid = pg_catalog.to_regrole('service_role')
      AND membership.member = pg_catalog.to_regrole('authenticator')
      AND NOT membership.admin_option
      AND NOT membership.inherit_option
      AND membership.set_option
  ) AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_auth_members AS membership
    WHERE membership.roleid = pg_catalog.to_regrole('service_role')
      AND membership.member NOT IN (
        pg_catalog.to_regrole('authenticator'),
        pg_catalog.to_regrole('postgres')
      )
  ) AND NOT EXISTS (
    SELECT 1
    FROM service_authority AS inherited
    JOIN pg_catalog.pg_roles AS role_row
      ON role_row.oid = inherited.member_oid
    WHERE inherited.member_oid NOT IN (
      pg_catalog.to_regrole('authenticator'),
      pg_catalog.to_regrole('postgres')
    )
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
          WHERE managed_membership.roleid = pg_catalog.to_regrole('postgres')
            AND managed_membership.member = role_row.oid
            AND NOT managed_membership.admin_option
            AND NOT managed_membership.inherit_option
            AND managed_membership.set_option
        )
      )
  ) AND NOT EXISTS (
    SELECT 1 FROM service_inherits
  ) AND NOT EXISTS (
    SELECT 1
    FROM protected_root
    WHERE (
      protected_root.origin_name IN ('anon', 'authenticated')
      AND (protected_root.rolsuper OR protected_root.rolbypassrls)
    ) OR (
      protected_root.origin_name = 'authenticator'
      AND (protected_root.rolsuper OR protected_root.rolbypassrls)
    ) OR (
      protected_root.origin_name = 'service_role'
      AND protected_root.rolsuper
    )
  ) AND NOT EXISTS (
    SELECT 1
    FROM membership_path
    JOIN pg_catalog.pg_roles AS reachable_role
      ON reachable_role.oid = membership_path.reachable_oid
    WHERE (
      membership_path.origin_name IN ('anon', 'authenticated')
      AND (
        reachable_role.rolname IN ('service_role', 'postgres')
        OR reachable_role.rolsuper
        OR reachable_role.rolbypassrls
      )
    ) OR (
      membership_path.origin_name = 'authenticator'
      AND (
        (
          reachable_role.rolname = 'service_role'
          AND NOT (
            membership_path.depth = 1
            AND membership_path.set_option
            AND NOT membership_path.inherit_option
            AND NOT membership_path.admin_option
          )
        ) OR (
          reachable_role.rolname <> 'service_role'
          AND (
            reachable_role.rolname = 'postgres'
            OR reachable_role.rolsuper
            OR reachable_role.rolbypassrls
          )
        )
      )
    )
  )
$function$;

-- The 1100 reserve/finalize authorities below are pinned to reviewed source
-- bytes because they establish registry identity. These four older content
-- authorities retain their upstream metadata/comment seals: their postgres
-- migration owner is part of the trusted management-plane boundary, and this
-- additive migration does not claim independent provenance for their bodies.
CREATE OR REPLACE FUNCTION pg_temp.post_media_claim_authorities_are_safe()
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $function$
  WITH expected(
    signature,
    function_name,
    argument_names,
    argument_count,
    default_count,
    required_config,
    comment_prefix,
    required
  ) AS (
    VALUES
      (
        'public.create_post_atomic(uuid,uuid,text,text,uuid,text[],boolean,text[],text,integer,text,boolean,text,text,text[],text[])',
        'create_post_atomic',
        ARRAY[
          'p_actor_id', 'p_operation_id', 'p_title', 'p_content',
          'p_group_id', 'p_images', 'p_poll_enabled',
          'p_poll_option_texts', 'p_poll_type', 'p_poll_duration_hours',
          'p_visibility', 'p_is_sensitive', 'p_content_warning',
          'p_language', 'p_mention_handles', 'p_hashtag_tags'
        ]::text[],
        16, 0,
        ARRAY[
          'search_path=pg_catalog, pg_temp', 'row_security=off',
          'lock_timeout=5s', 'statement_timeout=15s'
        ]::text[],
        'atomic-post-create:v1:', true
      ),
      (
        'public.edit_post_atomic(uuid,uuid,bigint,text,text,boolean,text[],text,text[],text[])',
        'edit_post_atomic',
        ARRAY[
          'p_actor_id', 'p_post_id', 'p_expected_version', 'p_title',
          'p_content', 'p_update_images', 'p_images', 'p_language',
          'p_mention_handles', 'p_hashtag_tags'
        ]::text[],
        10, 0,
        ARRAY[
          'search_path=pg_catalog, pg_temp', 'row_security=off',
          'lock_timeout=5s', 'statement_timeout=15s'
        ]::text[],
        'atomic-post-edit-facets:v2:', true
      ),
      (
        'public.edit_post_atomic(uuid,uuid,bigint,text,text,boolean,text[])',
        'edit_post_atomic',
        ARRAY[
          'p_actor_id', 'p_post_id', 'p_expected_version', 'p_title',
          'p_content', 'p_update_images', 'p_images'
        ]::text[],
        7, 0,
        ARRAY[
          'search_path=pg_catalog, pg_temp', 'row_security=off',
          'lock_timeout=5s', 'statement_timeout=15s'
        ]::text[],
        'atomic-post-edit:v1:', false
      ),
      (
        'public.submit_group_application_atomic(uuid,text,text,text,text,text,jsonb,jsonb,text,boolean,boolean,uuid)',
        'submit_group_application_atomic',
        ARRAY[
          'p_actor_id', 'p_name', 'p_name_en', 'p_description',
          'p_description_en', 'p_avatar_url', 'p_role_names',
          'p_rules_json', 'p_rules', 'p_is_premium_only',
          'p_promo_unlocked', 'p_operation_id'
        ]::text[],
        12, 10,
        ARRAY['search_path=pg_catalog, pg_temp', 'lock_timeout=5s']::text[],
        'group-application-operation-replay:submit:v1:', true
      ),
      (
        'public.review_group_application_atomic(uuid,uuid,text,text,boolean,uuid)',
        'review_group_application_atomic',
        ARRAY[
          'p_reviewer_id', 'p_application_id', 'p_decision',
          'p_reject_reason', 'p_promo_unlocked', 'p_operation_id'
        ]::text[],
        6, 3,
        ARRAY['search_path=pg_catalog, pg_temp', 'lock_timeout=5s']::text[],
        'group-application-operation-replay:review:v1:', true
      )
  ), resolved AS (
    SELECT expected.*,
      pg_catalog.to_regprocedure(expected.signature) AS function_oid
    FROM expected
  )
  SELECT NOT EXISTS (
    SELECT 1
    FROM resolved AS expected
    LEFT JOIN pg_catalog.pg_proc AS function_row
      ON function_row.oid = expected.function_oid
    WHERE (expected.required AND function_row.oid IS NULL)
       OR (
         function_row.oid IS NOT NULL
         AND (
       function_row.pronamespace <> 'public'::regnamespace
       OR function_row.proname <> expected.function_name
       OR function_row.prokind <> 'f'
       OR function_row.proowner <> pg_catalog.to_regrole('postgres')
       OR NOT function_row.prosecdef
       OR function_row.provolatile <> 'v'
       OR function_row.prolang <> (
         SELECT language_row.oid
         FROM pg_catalog.pg_language AS language_row
         WHERE language_row.lanname = 'plpgsql'
       )
       OR function_row.prorettype <> 'pg_catalog.jsonb'::regtype
       OR function_row.proretset
       OR function_row.proisstrict
       OR function_row.proparallel <> 'u'
       OR function_row.proleakproof
       OR function_row.pronargs <> expected.argument_count
       OR function_row.pronargdefaults <> expected.default_count
       OR function_row.proargnames IS DISTINCT FROM expected.argument_names
       OR function_row.proconfig IS DISTINCT FROM expected.required_config
       OR pg_catalog.obj_description(function_row.oid, 'pg_proc') IS DISTINCT FROM
          expected.comment_prefix || pg_catalog.md5(function_row.prosrc)
         )
       )
  ) AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.pronamespace = 'public'::regnamespace
      AND function_row.proname IN (
        'create_post_atomic', 'edit_post_atomic',
        'submit_group_application_atomic', 'review_group_application_atomic'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM resolved AS expected
        WHERE expected.function_oid = function_row.oid
      )
  ) AND NOT EXISTS (
    SELECT 1
    FROM resolved AS expected
    JOIN pg_catalog.pg_proc AS function_row
      ON function_row.oid = expected.function_oid
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        function_row.proacl,
        pg_catalog.acldefault('f', function_row.proowner)
      )
    ) AS acl_entry
    WHERE acl_entry.grantee <> function_row.proowner
      AND (
        acl_entry.grantee <> pg_catalog.to_regrole('service_role')
        OR acl_entry.privilege_type <> 'EXECUTE'
        OR acl_entry.is_grantable
      )
  ) AND NOT EXISTS (
    SELECT 1
    FROM resolved AS expected
    WHERE expected.function_oid IS NOT NULL
      AND (
      SELECT pg_catalog.count(*)
      FROM pg_catalog.pg_proc AS function_row
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          function_row.proacl,
          pg_catalog.acldefault('f', function_row.proowner)
        )
      ) AS acl_entry
      WHERE function_row.oid = expected.function_oid
        AND acl_entry.grantee = pg_catalog.to_regrole('service_role')
        AND acl_entry.privilege_type = 'EXECUTE'
        AND NOT acl_entry.is_grantable
    ) <> 1
  )
$function$;

-- Final publication attestation for the five new authorities. This is called
-- only after definitions, ownership, ACL convergence, and source comments are
-- installed, and pins the complete PostgreSQL 17 routine identity.
CREATE OR REPLACE FUNCTION pg_temp.post_media_claim_publication_is_exact()
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $function$
  WITH expected(
    signature,
    function_name,
    argument_names,
    argument_count,
    default_count,
    argument_definition_digest,
    source_digest,
    comment_prefix,
    service_exposed
  ) AS (
    VALUES
      (
        'public.claim_post_media_manifest_internal(text,uuid,uuid,uuid,text,uuid,uuid,bigint,bigint,text,text[],text,jsonb)',
        'claim_post_media_manifest_internal',
        ARRAY[
          'p_scope', 'p_operation_id', 'p_actor_id', 'p_media_owner_id',
          'p_target_kind', 'p_target_id', 'p_source_application_id',
          'p_requested_revision', 'p_target_revision', 'p_storage_origin',
          'p_media_object_names', 'p_intent_fingerprint', 'p_result'
        ]::text[],
        13, 0, '7f21301c3b69b016b72b1cd78d22bf56',
        '16ce55b402e98e4decb1e044dcd2f881',
        'post-media-claims:internal-v1:', false
      ),
      (
        'public.create_post_with_media_claims_atomic(uuid,uuid,text,text,uuid,text[],boolean,text[],text,integer,text,boolean,text,text,text[],text[],text[],text)',
        'create_post_with_media_claims_atomic',
        ARRAY[
          'p_actor_id', 'p_operation_id', 'p_title', 'p_content',
          'p_group_id', 'p_images', 'p_poll_enabled', 'p_poll_option_texts',
          'p_poll_type', 'p_poll_duration_hours', 'p_visibility',
          'p_is_sensitive', 'p_content_warning', 'p_language',
          'p_mention_handles', 'p_hashtag_tags', 'p_media_object_names',
          'p_storage_origin'
        ]::text[],
        18, 0, '7aa44283ca888dd7022c471ae0eded8f',
        '2982332579187d47e5d319e6699e9e91',
        'post-media-claims:create-v1:', true
      ),
      (
        'public.edit_post_with_media_claims_atomic(uuid,uuid,bigint,text,text,boolean,text[],text,text[],text[],text[],uuid,text)',
        'edit_post_with_media_claims_atomic',
        ARRAY[
          'p_actor_id', 'p_post_id', 'p_expected_version', 'p_title',
          'p_content', 'p_update_images', 'p_images', 'p_language',
          'p_mention_handles', 'p_hashtag_tags', 'p_media_object_names',
          'p_operation_id', 'p_storage_origin'
        ]::text[],
        13, 0, 'f41e85cf8dc13d33c6fadd7a93c22aba',
        '4ff2e5691dc27891442df50567a81c7d',
        'post-media-claims:edit-v1:', true
      ),
      (
        'public.submit_group_application_with_media_claims_atomic(uuid,text,text,text,text,text,jsonb,jsonb,text,boolean,boolean,uuid,text[],text)',
        'submit_group_application_with_media_claims_atomic',
        ARRAY[
          'p_actor_id', 'p_name', 'p_name_en', 'p_description',
          'p_description_en', 'p_avatar_url', 'p_role_names',
          'p_rules_json', 'p_rules', 'p_is_premium_only',
          'p_promo_unlocked', 'p_operation_id', 'p_media_object_names',
          'p_storage_origin'
        ]::text[],
        14, 12, '68e5695f2c2b87f7763b1e6c82a75c37',
        '3e46f03ddfa7bbd89e15b5d619109126',
        'post-media-claims:group-submit-v1:', true
      ),
      (
        'public.review_group_application_with_media_claims_atomic(uuid,uuid,text,text,boolean,uuid,text)',
        'review_group_application_with_media_claims_atomic',
        ARRAY[
          'p_reviewer_id', 'p_application_id', 'p_decision',
          'p_reject_reason', 'p_promo_unlocked', 'p_operation_id',
          'p_storage_origin'
        ]::text[],
        7, 4, '7f94fd69c3a26b14e14ebbd49ecda2dd',
        '0380908cb6c5ffca0ec86f683ebbbbe7',
        'post-media-claims:group-review-v1:', true
      )
  ), resolved AS (
    SELECT expected.*,
      pg_catalog.to_regprocedure(expected.signature) AS function_oid
    FROM expected
  )
  SELECT NOT EXISTS (
    SELECT 1
    FROM resolved AS expected
    LEFT JOIN pg_catalog.pg_proc AS function_row
      ON function_row.oid = expected.function_oid
    WHERE function_row.oid IS NULL
       OR function_row.pronamespace <> 'public'::regnamespace
       OR function_row.proname <> expected.function_name
       OR function_row.prokind <> 'f'
       OR function_row.proowner <> pg_catalog.to_regrole('postgres')
       OR NOT function_row.prosecdef
       OR function_row.provolatile <> 'v'
       OR function_row.prolang <> (
         SELECT language_row.oid
         FROM pg_catalog.pg_language AS language_row
         WHERE language_row.lanname = 'plpgsql'
       )
       OR function_row.prorettype <> 'pg_catalog.jsonb'::regtype
       OR function_row.proretset
       OR function_row.proisstrict
       OR function_row.proparallel <> 'u'
       OR function_row.proleakproof
       OR function_row.pronargs <> expected.argument_count
       OR function_row.pronargdefaults <> expected.default_count
       OR function_row.proargnames IS DISTINCT FROM expected.argument_names
       OR (expected.default_count = 0 AND function_row.proargdefaults IS NOT NULL)
       OR (expected.default_count > 0 AND function_row.proargdefaults IS NULL)
       OR pg_catalog.md5(pg_catalog.pg_get_function_arguments(
            function_row.oid
          )) IS DISTINCT FROM expected.argument_definition_digest
       OR pg_catalog.md5(function_row.prosrc) IS DISTINCT FROM
          expected.source_digest
       OR function_row.provariadic <> 0
       OR function_row.proargmodes IS NOT NULL
       OR function_row.proallargtypes IS NOT NULL
       OR function_row.protrftypes IS NOT NULL
       OR function_row.prosupport <> 0
       OR function_row.prosqlbody IS NOT NULL
       OR function_row.probin IS NOT NULL
       OR function_row.procost <> 100
       OR function_row.prorows <> 0
       OR function_row.proconfig IS DISTINCT FROM ARRAY[
         'search_path=pg_catalog, pg_temp', 'row_security=off',
         'lock_timeout=5s', 'statement_timeout=15s'
       ]::text[]
       OR pg_catalog.obj_description(function_row.oid, 'pg_proc')
          IS DISTINCT FROM
          expected.comment_prefix || expected.source_digest
  ) AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.pronamespace = 'public'::regnamespace
      AND function_row.proname IN (
        'claim_post_media_manifest_internal',
        'create_post_with_media_claims_atomic',
        'edit_post_with_media_claims_atomic',
        'submit_group_application_with_media_claims_atomic',
        'review_group_application_with_media_claims_atomic'
      )
      AND NOT EXISTS (
        SELECT 1 FROM resolved AS expected
        WHERE expected.function_oid = function_row.oid
      )
  ) AND NOT EXISTS (
    SELECT 1
    FROM resolved AS expected
    JOIN pg_catalog.pg_proc AS function_row
      ON function_row.oid = expected.function_oid
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        function_row.proacl,
        pg_catalog.acldefault('f', function_row.proowner)
      )
    ) AS acl_entry
    WHERE acl_entry.grantee <> function_row.proowner
      AND (
        NOT expected.service_exposed
        OR acl_entry.grantee <> pg_catalog.to_regrole('service_role')
        OR acl_entry.privilege_type <> 'EXECUTE'
        OR acl_entry.is_grantable
      )
  ) AND NOT EXISTS (
    SELECT 1
    FROM resolved AS expected
    WHERE (
      SELECT pg_catalog.count(*)
      FROM pg_catalog.pg_proc AS function_row
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          function_row.proacl,
          pg_catalog.acldefault('f', function_row.proowner)
        )
      ) AS acl_entry
      WHERE function_row.oid = expected.function_oid
        AND acl_entry.grantee = pg_catalog.to_regrole('service_role')
        AND acl_entry.privilege_type = 'EXECUTE'
        AND NOT acl_entry.is_grantable
    ) IS DISTINCT FROM CASE
      WHEN expected.service_exposed THEN 1::bigint ELSE 0::bigint
    END
  )
$function$;

CREATE OR REPLACE FUNCTION pg_temp.post_media_upload_registry_is_exact()
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $function$
  WITH expected_column(
    column_number,
    column_name,
    type_oid,
    required_not_null,
    default_expression,
    collation_oid,
    storage_code
  ) AS (
    VALUES
      (
        1, 'upload_id', 'uuid'::regtype, true, NULL::text, 0::oid,
        'p'::"char"
      ),
      (
        2, 'owner_id', 'uuid'::regtype, true, NULL::text, 0::oid,
        'p'::"char"
      ),
      (
        3, 'object_name', 'text'::regtype, true, NULL::text,
        'pg_catalog."default"'::regcollation, 'x'::"char"
      ),
      (
        4, 'purpose', 'text'::regtype, true, NULL::text,
        'pg_catalog."default"'::regcollation, 'x'::"char"
      ),
      (
        5, 'mime_type', 'text'::regtype, true, NULL::text,
        'pg_catalog."default"'::regcollation, 'x'::"char"
      ),
      (
        6, 'size_bytes', 'int8'::regtype, true, NULL::text, 0::oid,
        'p'::"char"
      ),
      (
        7, 'status', 'text'::regtype, true, '''reserved''::text',
        'pg_catalog."default"'::regcollation, 'x'::"char"
      ),
      (
        8, 'expires_at', 'timestamptz'::regtype, true, NULL::text, 0::oid,
        'p'::"char"
      ),
      (
        9, 'created_at', 'timestamptz'::regtype, true,
        'statement_timestamp()', 0::oid, 'p'::"char"
      ),
      (
        10, 'updated_at', 'timestamptz'::regtype, true,
        'statement_timestamp()', 0::oid, 'p'::"char"
      ),
      (
        11, 'gc_admitted_at', 'timestamptz'::regtype, false, NULL::text,
        0::oid, 'p'::"char"
      )
  ), actual_column AS (
    SELECT
      attribute.attnum AS column_number,
      attribute.attname::text AS column_name,
      attribute.atttypid AS type_oid,
      attribute.attnotnull AS required_not_null,
      pg_catalog.pg_get_expr(
        default_row.adbin, default_row.adrelid, true
      ) AS default_expression,
      attribute.attcollation,
      attribute.attstorage,
      attribute.attidentity,
      attribute.attgenerated,
      attribute.atttypmod,
      attribute.attndims,
      attribute.attstattarget,
      attribute.attcompression,
      attribute.attinhcount,
      attribute.attislocal,
      attribute.atthasmissing,
      attribute.attoptions,
      attribute.attfdwoptions
    FROM pg_catalog.pg_attribute AS attribute
    LEFT JOIN pg_catalog.pg_attrdef AS default_row
      ON default_row.adrelid = attribute.attrelid
     AND default_row.adnum = attribute.attnum
    WHERE attribute.attrelid = 'public.post_media_uploads'::regclass
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  ), expected_constraint(constraint_name, definition_digest) AS (
    VALUES
      ('post_media_uploads_lifecycle_check', '6110171e15c955de46058c9a0e800174'),
      ('post_media_uploads_media_check', 'b607d427abf640dd52d74f07b780542b'),
      ('post_media_uploads_object_name_check', '5e1c4876bde6236817377ec6964762a3'),
      ('post_media_uploads_object_name_key', '693ce417e8b6cde5db0a40e4b6b4f057'),
      ('post_media_uploads_pkey', '4fb802a92a43361ca53ee08d48a1d19c'),
      ('post_media_uploads_purpose_check', 'bf4dc82a81f6e525549898b9a30abd02'),
      ('post_media_uploads_status_check', '675ed1dfca4b0e465550cc52151b706d')
  ), expected_index(
    index_name,
    definition_digest,
    expected_unique,
    expected_primary,
    expected_keys
  ) AS (
    VALUES
      (
        'post_media_uploads_pkey',
        '73b89f97e6aa34b2f90543242d900ce4', true, true, 1
      ),
      (
        'post_media_uploads_object_name_key',
        '743d250045e625fe778fa80dd2844b63', true, false, 1
      ),
      (
        'post_media_uploads_expiry_idx',
        '83876798b71ac8054d76c9e09709dea4', false, false, 3
      )
  )
  SELECT (
    SELECT relation.relkind = 'r'
      AND relation.relpersistence = 'p'
      AND NOT relation.relispartition
      AND relation.relowner = pg_catalog.to_regrole('postgres')
      AND relation.relam = (
        SELECT access_method.oid
        FROM pg_catalog.pg_am AS access_method
        WHERE access_method.amname = 'heap'
          AND access_method.amtype = 't'
      )
      AND relation.relrowsecurity
      AND relation.relforcerowsecurity
      AND relation.reloptions IS NULL
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = 'public.post_media_uploads'::regclass
  ) AND NOT EXISTS (
    SELECT 1
    FROM expected_column AS expected
    FULL JOIN actual_column AS actual USING (column_number)
    WHERE expected.column_name IS NULL
       OR actual.column_name IS NULL
       OR actual.column_name IS DISTINCT FROM expected.column_name
       OR actual.type_oid IS DISTINCT FROM expected.type_oid
       OR actual.required_not_null IS DISTINCT FROM expected.required_not_null
       OR actual.default_expression IS DISTINCT FROM expected.default_expression
       OR actual.attcollation IS DISTINCT FROM expected.collation_oid
       OR actual.attstorage IS DISTINCT FROM expected.storage_code
       OR actual.attidentity <> ''
       OR actual.attgenerated <> ''
       OR actual.atttypmod <> -1
       OR actual.attndims <> 0
       OR actual.attstattarget <> -1
       OR actual.attcompression <> ''
       OR actual.attinhcount <> 0
       OR NOT actual.attislocal
       OR actual.atthasmissing
       OR actual.attoptions IS NOT NULL
       OR actual.attfdwoptions IS NOT NULL
  ) AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = 'public.post_media_uploads'::regclass
      AND attribute.attnum > 0
      AND attribute.attisdropped
  ) AND NOT EXISTS (
    SELECT 1
    FROM expected_constraint AS expected
    FULL JOIN (
      SELECT constraint_row.*
      FROM pg_catalog.pg_constraint AS constraint_row
      WHERE constraint_row.conrelid = 'public.post_media_uploads'::regclass
    ) AS actual ON actual.conname = expected.constraint_name
    WHERE actual.oid IS NULL
       OR expected.constraint_name IS NULL
       OR NOT actual.convalidated
       OR actual.condeferrable
       OR actual.condeferred
       OR NOT actual.conislocal
       OR actual.coninhcount <> 0
       OR actual.conparentid <> 0
       OR pg_catalog.md5(
            pg_catalog.pg_get_constraintdef(actual.oid, true)
          ) IS DISTINCT FROM expected.definition_digest
  ) AND (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.post_media_uploads'::regclass
  ) = 7 AND NOT EXISTS (
    SELECT 1
    FROM expected_index AS expected
    FULL JOIN (
      SELECT index_row.*, index_relation.relname::text AS index_name,
        access_method.amname
      FROM pg_catalog.pg_index AS index_row
      JOIN pg_catalog.pg_class AS index_relation
        ON index_relation.oid = index_row.indexrelid
      JOIN pg_catalog.pg_am AS access_method
        ON access_method.oid = index_relation.relam
      WHERE index_row.indrelid = 'public.post_media_uploads'::regclass
    ) AS actual ON actual.index_name = expected.index_name
    WHERE actual.indexrelid IS NULL
       OR expected.index_name IS NULL
       OR actual.amname <> 'btree'
       OR actual.indisunique IS DISTINCT FROM expected.expected_unique
       OR actual.indisprimary IS DISTINCT FROM expected.expected_primary
       OR NOT actual.indisvalid
       OR NOT actual.indisready
       OR NOT actual.indislive
       OR actual.indisexclusion
       OR NOT actual.indimmediate
       OR actual.indisclustered
       OR actual.indisreplident
       OR actual.indpred IS NOT NULL
       OR actual.indexprs IS NOT NULL
       OR actual.indnkeyatts <> expected.expected_keys
       OR actual.indnatts <> expected.expected_keys
       OR pg_catalog.md5(
            pg_catalog.pg_get_indexdef(actual.indexrelid)
          ) IS DISTINCT FROM expected.definition_digest
  ) AND (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_index AS index_row
    WHERE index_row.indrelid = 'public.post_media_uploads'::regclass
  ) = 3 AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_inherits AS inheritance
    WHERE inheritance.inhrelid = 'public.post_media_uploads'::regclass
       OR inheritance.inhparent = 'public.post_media_uploads'::regclass
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_rewrite AS rewrite_rule
    WHERE rewrite_rule.ev_class = 'public.post_media_uploads'::regclass
      AND rewrite_rule.rulename <> '_RETURN'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.post_media_uploads'::regclass
      AND NOT trigger_row.tgisinternal
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.post_media_uploads'::regclass
  ) AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        relation.relacl,
        pg_catalog.acldefault('r', relation.relowner)
      )
    ) AS acl_entry
    WHERE relation.oid = 'public.post_media_uploads'::regclass
      AND acl_entry.grantee <> relation.relowner
  ) AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl_entry
    WHERE attribute.attrelid = 'public.post_media_uploads'::regclass
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND acl_entry.grantee <> pg_catalog.to_regrole('postgres')
  )
$function$;

CREATE OR REPLACE FUNCTION pg_temp.post_media_upload_authorities_are_safe()
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $function$
  WITH expected(
    signature, argument_names, argument_definition_digest,
    source_digest, comment_prefix
  ) AS (
    VALUES
      (
        'public.reserve_post_media_upload_atomic(uuid,uuid,text,text,text,bigint)',
        ARRAY[
          'p_upload_id', 'p_owner_id', 'p_object_name', 'p_purpose',
          'p_mime_type', 'p_size_bytes'
        ]::text[],
        '1c403e56f319e2b97fff483724845fb8',
        '56e6f09a800136a55e4249b2cf1ba9c4',
        'post-media-upload-registry:reserve-v1:'
      ),
      (
        'public.finalize_post_media_upload_atomic(uuid,uuid,text,text,text,bigint)',
        ARRAY[
          'p_upload_id', 'p_owner_id', 'p_object_name', 'p_purpose',
          'p_mime_type', 'p_size_bytes'
        ]::text[],
        '1c403e56f319e2b97fff483724845fb8',
        '4ff0dbce52d166d77321738991f75250',
        'post-media-upload-registry:finalize-v1:'
      )
  ), resolved AS (
    SELECT expected.*,
      pg_catalog.to_regprocedure(expected.signature) AS function_oid
    FROM expected
  )
  SELECT NOT EXISTS (
    SELECT 1
    FROM resolved AS expected
    LEFT JOIN pg_catalog.pg_proc AS function_row
      ON function_row.oid = expected.function_oid
    WHERE function_row.oid IS NULL
       OR function_row.prokind <> 'f'
       OR function_row.proowner <> pg_catalog.to_regrole('postgres')
       OR NOT function_row.prosecdef
       OR function_row.provolatile <> 'v'
       OR function_row.prolang <> (
         SELECT language_row.oid FROM pg_catalog.pg_language AS language_row
         WHERE language_row.lanname = 'plpgsql'
       )
       OR function_row.prorettype <> 'jsonb'::regtype
       OR function_row.proretset
       OR function_row.proisstrict
       OR function_row.proparallel <> 'u'
       OR function_row.proleakproof
       OR function_row.pronargs <> 6
       OR function_row.pronargdefaults <> 0
       OR function_row.proargdefaults IS NOT NULL
       OR function_row.proargnames IS DISTINCT FROM expected.argument_names
       OR pg_catalog.md5(pg_catalog.pg_get_function_arguments(
            function_row.oid
          )) IS DISTINCT FROM expected.argument_definition_digest
       OR pg_catalog.md5(function_row.prosrc) IS DISTINCT FROM
          expected.source_digest
       OR function_row.provariadic <> 0
       OR function_row.proargmodes IS NOT NULL
       OR function_row.proallargtypes IS NOT NULL
       OR function_row.protrftypes IS NOT NULL
       OR function_row.prosupport <> 0
       OR function_row.prosqlbody IS NOT NULL
       OR function_row.probin IS NOT NULL
       OR function_row.procost <> 100
       OR function_row.prorows <> 0
       OR function_row.proconfig IS DISTINCT FROM ARRAY[
         'search_path=pg_catalog, pg_temp', 'row_security=off',
         'lock_timeout=5s', 'statement_timeout=15s'
       ]::text[]
       OR pg_catalog.obj_description(function_row.oid, 'pg_proc') IS DISTINCT FROM
          expected.comment_prefix || expected.source_digest
  ) AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.pronamespace = 'public'::regnamespace
      AND function_row.proname IN (
        'reserve_post_media_upload_atomic',
        'finalize_post_media_upload_atomic'
      )
      AND NOT EXISTS (
        SELECT 1 FROM resolved AS expected
        WHERE expected.function_oid = function_row.oid
      )
  ) AND NOT EXISTS (
    SELECT 1
    FROM resolved AS expected
    JOIN pg_catalog.pg_proc AS function_row
      ON function_row.oid = expected.function_oid
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        function_row.proacl,
        pg_catalog.acldefault('f', function_row.proowner)
      )
    ) AS acl_entry
    WHERE acl_entry.grantee <> function_row.proowner
      AND (
        acl_entry.grantee <> pg_catalog.to_regrole('service_role')
        OR acl_entry.privilege_type <> 'EXECUTE'
        OR acl_entry.is_grantable
      )
  ) AND NOT EXISTS (
    SELECT 1 FROM resolved AS expected
    WHERE expected.function_oid IS NOT NULL
      AND (
      SELECT pg_catalog.count(*)
      FROM pg_catalog.pg_proc AS function_row
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          function_row.proacl,
          pg_catalog.acldefault('f', function_row.proowner)
        )
      ) AS acl_entry
      WHERE function_row.oid = expected.function_oid
        AND acl_entry.grantee = pg_catalog.to_regrole('service_role')
        AND acl_entry.privilege_type = 'EXECUTE'
        AND NOT acl_entry.is_grantable
    ) <> 1
  )
$function$;

CREATE OR REPLACE FUNCTION pg_temp.post_media_claim_existing_tables_fingerprint(
  p_claim_sets_oid oid,
  p_claims_oid oid
)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $function$
  WITH relation_map AS (
    SELECT p_claim_sets_oid AS relation_oid, 'claim_sets'::text AS marker
    UNION ALL
    SELECT p_claims_oid, 'claims'::text
  )
  SELECT pg_catalog.md5(pg_catalog.jsonb_build_object(
    'relations', (
      SELECT pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'table', relation_map.marker,
          'kind', relation.relkind,
          'persistence', relation.relpersistence,
          'partition', relation.relispartition,
          'access_method', access_method.amname,
          'owner', owner_role.rolname,
          'rls', relation.relrowsecurity,
          'force_rls', relation.relforcerowsecurity,
          'replica_identity', relation.relreplident,
          'options', pg_catalog.to_jsonb(relation.reloptions),
          'nonowner_acl', (
            SELECT pg_catalog.count(*)
            FROM pg_catalog.aclexplode(COALESCE(
              relation.relacl,
              pg_catalog.acldefault('r', relation.relowner)
            )) AS acl_entry
            WHERE acl_entry.grantee <> relation.relowner
          )
        ) ORDER BY relation_map.marker
      )
      FROM relation_map
      JOIN pg_catalog.pg_class AS relation
        ON relation.oid = relation_map.relation_oid
      JOIN pg_catalog.pg_roles AS owner_role
        ON owner_role.oid = relation.relowner
      LEFT JOIN pg_catalog.pg_am AS access_method
        ON access_method.oid = relation.relam
    ),
    'columns', (
      SELECT pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'table', relation_map.marker,
          'num', attribute.attnum,
          'name', attribute.attname,
          'type', attribute.atttypid::pg_catalog.regtype::text,
          'not_null', attribute.attnotnull,
          'default', pg_catalog.pg_get_expr(
            default_row.adbin, default_row.adrelid, true
          ),
          'collation', CASE WHEN attribute.attcollation = 0 THEN NULL
            ELSE attribute.attcollation::pg_catalog.regcollation::text END,
          'identity', attribute.attidentity,
          'generated', attribute.attgenerated,
          'typmod', attribute.atttypmod,
          'ndims', attribute.attndims,
          'stats', attribute.attstattarget,
          'compression', attribute.attcompression,
          'storage', attribute.attstorage,
          'inhcount', attribute.attinhcount,
          'local', attribute.attislocal,
          'missing', attribute.atthasmissing,
          'options', pg_catalog.to_jsonb(attribute.attoptions),
          'fdw_options', pg_catalog.to_jsonb(attribute.attfdwoptions),
          'nonowner_acl', (
            SELECT pg_catalog.count(*)
            FROM pg_catalog.aclexplode(attribute.attacl) AS acl_entry
            WHERE acl_entry.grantee <> relation.relowner
          )
        ) ORDER BY relation_map.marker, attribute.attnum
      )
      FROM relation_map
      JOIN pg_catalog.pg_class AS relation
        ON relation.oid = relation_map.relation_oid
      JOIN pg_catalog.pg_attribute AS attribute
        ON attribute.attrelid = relation_map.relation_oid
       AND attribute.attnum > 0
       AND NOT attribute.attisdropped
      LEFT JOIN pg_catalog.pg_attrdef AS default_row
        ON default_row.adrelid = attribute.attrelid
       AND default_row.adnum = attribute.attnum
    ),
    'dropped_columns', (
      SELECT pg_catalog.count(*)
      FROM relation_map
      JOIN pg_catalog.pg_attribute AS attribute
        ON attribute.attrelid = relation_map.relation_oid
       AND attribute.attnum > 0
       AND attribute.attisdropped
    ),
    'constraints', (
      SELECT pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'table', relation_map.marker,
          'name', constraint_row.conname,
          'type', constraint_row.contype,
          'definition', pg_catalog.md5(pg_catalog.pg_get_constraintdef(
            constraint_row.oid, true
          )),
          'validated', constraint_row.convalidated,
          'deferrable', constraint_row.condeferrable,
          'deferred', constraint_row.condeferred,
          'local', constraint_row.conislocal,
          'inhcount', constraint_row.coninhcount,
          'parent', constraint_row.conparentid,
          'delete_action', constraint_row.confdeltype,
          'update_action', constraint_row.confupdtype
        ) ORDER BY relation_map.marker, constraint_row.conname
      )
      FROM relation_map
      JOIN pg_catalog.pg_constraint AS constraint_row
        ON constraint_row.conrelid = relation_map.relation_oid
    ),
    'indexes', (
      SELECT pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'table', relation_map.marker,
          'name', index_relation.relname,
          'method', access_method.amname,
          'definition', pg_catalog.md5(pg_catalog.pg_get_indexdef(
            index_row.indexrelid
          )),
          'unique', index_row.indisunique,
          'primary', index_row.indisprimary,
          'valid', index_row.indisvalid,
          'ready', index_row.indisready,
          'live', index_row.indislive,
          'exclusion', index_row.indisexclusion,
          'immediate', index_row.indimmediate,
          'clustered', index_row.indisclustered,
          'replica_identity', index_row.indisreplident,
          'keys', index_row.indnkeyatts,
          'attributes', index_row.indnatts,
          'predicate', index_row.indpred IS NOT NULL,
          'expressions', index_row.indexprs IS NOT NULL
        ) ORDER BY relation_map.marker, index_relation.relname
      )
      FROM relation_map
      JOIN pg_catalog.pg_index AS index_row
        ON index_row.indrelid = relation_map.relation_oid
      JOIN pg_catalog.pg_class AS index_relation
        ON index_relation.oid = index_row.indexrelid
      JOIN pg_catalog.pg_am AS access_method
        ON access_method.oid = index_relation.relam
    ),
    'inheritance', (
      SELECT pg_catalog.count(*)
      FROM pg_catalog.pg_inherits AS inheritance
      WHERE inheritance.inhrelid IN (p_claim_sets_oid, p_claims_oid)
         OR inheritance.inhparent IN (p_claim_sets_oid, p_claims_oid)
    ),
    'rewrite_rules', (
      SELECT pg_catalog.count(*)
      FROM pg_catalog.pg_rewrite AS rewrite_rule
      WHERE rewrite_rule.ev_class IN (p_claim_sets_oid, p_claims_oid)
        AND rewrite_rule.rulename <> '_RETURN'
    ),
    'user_triggers', (
      SELECT pg_catalog.count(*)
      FROM pg_catalog.pg_trigger AS trigger_row
      WHERE trigger_row.tgrelid IN (p_claim_sets_oid, p_claims_oid)
        AND NOT trigger_row.tgisinternal
    ),
    'policies', (
      SELECT pg_catalog.count(*)
      FROM pg_catalog.pg_policy AS policy
      WHERE policy.polrelid IN (p_claim_sets_oid, p_claims_oid)
    )
  )::text)
$function$;

CREATE OR REPLACE FUNCTION pg_temp.post_media_claim_fk_triggers_are_safe(
  p_claims_oid oid,
  p_uploads_oid oid
)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $function$
  WITH foreign_key AS (
    SELECT constraint_row.oid
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = p_claims_oid
      AND constraint_row.confrelid = p_uploads_oid
      AND constraint_row.conname = 'post_media_claims_upload_fkey'
      AND constraint_row.contype = 'f'
  ), expected(relation_oid, function_oid, trigger_type) AS (
    VALUES
      (
        p_claims_oid,
        'pg_catalog."RI_FKey_check_ins"()'::regprocedure::oid,
        5::smallint
      ),
      (
        p_claims_oid,
        'pg_catalog."RI_FKey_check_upd"()'::regprocedure::oid,
        17::smallint
      ),
      (
        p_uploads_oid,
        'pg_catalog."RI_FKey_restrict_del"()'::regprocedure::oid,
        9::smallint
      ),
      (
        p_uploads_oid,
        'pg_catalog."RI_FKey_restrict_upd"()'::regprocedure::oid,
        17::smallint
      )
  ), actual AS (
    SELECT trigger_row.*
    FROM foreign_key
    JOIN pg_catalog.pg_trigger AS trigger_row
      ON trigger_row.tgconstraint = foreign_key.oid
  )
  SELECT (SELECT pg_catalog.count(*) FROM foreign_key) = 1
    AND NOT EXISTS (
      SELECT 1
      FROM expected
      FULL JOIN actual
        ON actual.tgrelid = expected.relation_oid
       AND actual.tgfoid = expected.function_oid
       AND actual.tgtype = expected.trigger_type
      WHERE expected.relation_oid IS NULL
         OR actual.oid IS NULL
         OR NOT actual.tgisinternal
         OR actual.tgenabled <> 'O'
         OR actual.tgdeferrable
         OR actual.tginitdeferred
         OR actual.tgparentid <> 0
         OR actual.tgconstrindid IS DISTINCT FROM (
           SELECT index_row.indexrelid
           FROM pg_catalog.pg_index AS index_row
           JOIN pg_catalog.pg_class AS index_relation
             ON index_relation.oid = index_row.indexrelid
           WHERE index_row.indrelid = p_uploads_oid
             AND index_relation.relname = 'post_media_uploads_pkey'
         )
         OR actual.tgnargs <> 0
         OR actual.tgattr <> ''::pg_catalog.int2vector
         OR pg_catalog.octet_length(actual.tgargs) <> 0
         OR actual.tgconstrrelid IS DISTINCT FROM CASE
           WHEN expected.relation_oid = p_claims_oid
             THEN p_uploads_oid ELSE p_claims_oid
         END
         OR actual.tgqual IS NOT NULL
         OR actual.tgoldtable IS NOT NULL
         OR actual.tgnewtable IS NOT NULL
    )
    AND (SELECT pg_catalog.count(*) FROM actual) = 4
$function$;

DO $preflight$
DECLARE
  v_claim_sets_exists boolean;
  v_claims_exists boolean;
  v_claim_sets_oid oid;
  v_claims_oid oid;
  v_existing_tables_fingerprint text;
  v_publication_count bigint;
  v_role text;
  v_signature text;
BEGIN
  IF pg_catalog.current_setting('server_version_num')::integer / 10000 <> 17
  THEN
    RAISE EXCEPTION 'post media claims require PostgreSQL 17';
  END IF;

  v_claim_sets_oid := pg_catalog.to_regclass('public.post_media_claim_sets');
  v_claims_oid := pg_catalog.to_regclass('public.post_media_claims');
  v_claim_sets_exists := v_claim_sets_oid IS NOT NULL;
  v_claims_exists := v_claims_oid IS NOT NULL;
  IF v_claim_sets_exists IS DISTINCT FROM v_claims_exists THEN
    RAISE EXCEPTION 'post media claim table publication is partial';
  END IF;
  PERFORM pg_catalog.set_config(
    'ranking_arena.post_media_claim_fresh_install',
    (NOT v_claim_sets_exists)::text,
    true
  );

  FOREACH v_role IN ARRAY ARRAY[
    'postgres', 'anon', 'authenticated', 'authenticator', 'service_role'
  ]::text[]
  LOOP
    IF pg_catalog.to_regrole(v_role) IS NULL THEN
      RAISE EXCEPTION 'required post-media claim role is unavailable: %',
        v_role;
    END IF;
  END LOOP;

  IF NOT pg_temp.post_media_claim_role_graph_is_safe() THEN
    RAISE EXCEPTION 'post media claim role graph is unsafe';
  END IF;

  IF pg_catalog.to_regprocedure('auth.role()') IS NULL
     OR pg_catalog.to_regclass('public.post_media_uploads') IS NULL
     OR pg_catalog.to_regclass('public.posts') IS NULL
     OR pg_catalog.to_regclass('public.group_applications') IS NULL
     OR pg_catalog.to_regclass('public.groups') IS NULL
     OR pg_catalog.to_regclass('storage.objects') IS NULL
  THEN
    RAISE EXCEPTION 'post media claim foundations are unavailable';
  END IF;

  -- Migration table locks follow the runtime topology: existing business
  -- authority rows, registry/Storage identity, then the append-only claim
  -- ledgers. Existing ledgers are taken ACCESS EXCLUSIVE immediately after
  -- the foundations so later static DDL never performs a SHARE->AEL upgrade
  -- against a runtime claim writer.
  EXECUTE
    'LOCK TABLE public.posts, public.group_applications, public.groups, '
    || 'public.post_media_uploads, storage.objects IN SHARE MODE';
  IF v_claim_sets_exists THEN
    EXECUTE
      'LOCK TABLE public.post_media_claim_sets, public.post_media_claims '
      || 'IN ACCESS EXCLUSIVE MODE';
  END IF;

  IF v_claim_sets_exists THEN
    v_existing_tables_fingerprint :=
      pg_temp.post_media_claim_existing_tables_fingerprint(
        v_claim_sets_oid, v_claims_oid
      );
    IF v_existing_tables_fingerprint IS DISTINCT FROM
      'e17da204d61dccf5e37161b64e53f369'
       OR NOT pg_temp.post_media_claim_fk_triggers_are_safe(
         v_claims_oid,
         pg_catalog.to_regclass('public.post_media_uploads')
       )
    THEN
      RAISE EXCEPTION 'post media claim existing table contract is unsafe';
    END IF;
  END IF;

  IF NOT pg_temp.post_media_upload_registry_is_exact()
     OR NOT pg_temp.post_media_upload_authorities_are_safe()
  THEN
    RAISE EXCEPTION 'post media upload registry dependency is unsafe';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('bucket_id', 'text'::regtype),
        ('name', 'text'::regtype)
    ) AS expected(column_name, type_oid)
    LEFT JOIN pg_catalog.pg_attribute AS attribute
      ON attribute.attrelid = 'storage.objects'::regclass
     AND attribute.attname = expected.column_name
     AND attribute.attnum > 0
     AND NOT attribute.attisdropped
    WHERE attribute.attname IS NULL
       OR attribute.atttypid IS DISTINCT FROM expected.type_oid
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index AS index_row
    WHERE index_row.indrelid = 'storage.objects'::regclass
      AND index_row.indisunique
      AND index_row.indisvalid
      AND index_row.indisready
      AND index_row.indpred IS NULL
      AND index_row.indexprs IS NULL
      AND index_row.indnkeyatts = 2
      AND index_row.indnatts = 2
      AND (
        SELECT pg_catalog.array_agg(attribute.attname ORDER BY key.ordinality)
        FROM pg_catalog.unnest(index_row.indkey)
          WITH ORDINALITY AS key(attnum, ordinality)
        JOIN pg_catalog.pg_attribute AS attribute
          ON attribute.attrelid = index_row.indrelid
         AND attribute.attnum = key.attnum
      ) = ARRAY['bucket_id', 'name']::name[]
  ) THEN
    RAISE EXCEPTION 'exact posts Storage object identity is unavailable';
  END IF;

  IF NOT (
    SELECT relation.relkind = 'r'
      AND relation.relpersistence = 'p'
      AND NOT relation.relispartition
      AND relation.relowner = pg_catalog.to_regrole('postgres')
      AND relation.relrowsecurity
      AND relation.relforcerowsecurity
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = 'public.post_media_uploads'::pg_catalog.regclass
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid =
      'public.post_media_uploads'::pg_catalog.regclass
  ) THEN
    RAISE EXCEPTION 'post media upload registry privacy has drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid =
        'public.post_media_uploads'::pg_catalog.regclass
      AND attribute.attname IN (
        'upload_id', 'owner_id', 'object_name', 'purpose', 'status',
        'expires_at', 'gc_admitted_at'
      )
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
    HAVING pg_catalog.count(*) <> 7
  ) THEN
    RAISE EXCEPTION 'post media upload registry columns have drifted';
  END IF;

  FOREACH v_signature IN ARRAY ARRAY[
    'public.create_post_atomic(uuid,uuid,text,text,uuid,text[],boolean,text[],text,integer,text,boolean,text,text,text[],text[])',
    'public.edit_post_atomic(uuid,uuid,bigint,text,text,boolean,text[],text,text[],text[])',
    'public.submit_group_application_atomic(uuid,text,text,text,text,text,jsonb,jsonb,text,boolean,boolean,uuid)',
    'public.review_group_application_atomic(uuid,uuid,text,text,boolean,uuid)'
  ]::text[]
  LOOP
    IF pg_catalog.to_regprocedure(v_signature) IS NULL THEN
      RAISE EXCEPTION 'required atomic authority is unavailable: %',
        v_signature;
    END IF;
  END LOOP;

  IF NOT pg_temp.post_media_claim_authorities_are_safe() THEN
    RAISE EXCEPTION 'composed post media claim authority is unsafe';
  END IF;

  SELECT pg_catalog.count(*)
  INTO v_publication_count
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.pronamespace = 'public'::pg_catalog.regnamespace
    AND function_row.proname IN (
      'claim_post_media_manifest_internal',
      'create_post_with_media_claims_atomic',
      'edit_post_with_media_claims_atomic',
      'submit_group_application_with_media_claims_atomic',
      'review_group_application_with_media_claims_atomic'
    );
  IF (
    NOT v_claim_sets_exists
    AND v_publication_count <> 0
  ) OR (
    v_claim_sets_exists
    AND (
      v_publication_count <> 5
      OR NOT pg_temp.post_media_claim_publication_is_exact()
    )
  ) THEN
    RAISE EXCEPTION 'post media claim publication is partial or unsafe';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.pronamespace = 'public'::pg_catalog.regnamespace
      AND function_row.proname IN (
        'claim_post_media_manifest_internal',
        'create_post_with_media_claims_atomic',
        'edit_post_with_media_claims_atomic',
        'submit_group_application_with_media_claims_atomic',
        'review_group_application_with_media_claims_atomic'
      )
      AND function_row.oid IS DISTINCT FROM CASE function_row.proname
        WHEN 'claim_post_media_manifest_internal' THEN
          pg_catalog.to_regprocedure(
            'public.claim_post_media_manifest_internal(text,uuid,uuid,uuid,text,uuid,uuid,bigint,bigint,text,text[],text,jsonb)'
          )::oid
        WHEN 'create_post_with_media_claims_atomic' THEN
          pg_catalog.to_regprocedure(
            'public.create_post_with_media_claims_atomic(uuid,uuid,text,text,uuid,text[],boolean,text[],text,integer,text,boolean,text,text,text[],text[],text[],text)'
          )::oid
        WHEN 'edit_post_with_media_claims_atomic' THEN
          pg_catalog.to_regprocedure(
            'public.edit_post_with_media_claims_atomic(uuid,uuid,bigint,text,text,boolean,text[],text,text[],text[],text[],uuid,text)'
          )::oid
        WHEN 'submit_group_application_with_media_claims_atomic' THEN
          pg_catalog.to_regprocedure(
            'public.submit_group_application_with_media_claims_atomic(uuid,text,text,text,text,text,jsonb,jsonb,text,boolean,boolean,uuid,text[],text)'
          )::oid
        WHEN 'review_group_application_with_media_claims_atomic' THEN
          pg_catalog.to_regprocedure(
            'public.review_group_application_with_media_claims_atomic(uuid,uuid,text,text,boolean,uuid,text)'
          )::oid
      END
  ) THEN
    RAISE EXCEPTION 'incompatible post media claim overload exists';
  END IF;
END
$preflight$;

CREATE TABLE IF NOT EXISTS public.post_media_claim_sets (
  scope text NOT NULL,
  operation_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  target_kind text NOT NULL,
  target_id uuid NOT NULL,
  requested_revision bigint,
  target_revision bigint,
  manifest_fingerprint text NOT NULL,
  intent_fingerprint text NOT NULL,
  object_count integer NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.statement_timestamp(),
  CONSTRAINT post_media_claim_sets_pkey PRIMARY KEY (scope, operation_id),
  CONSTRAINT post_media_claim_sets_scope_check CHECK (
    scope IN ('post_create', 'post_edit', 'group_submit', 'group_review')
  ),
  CONSTRAINT post_media_claim_sets_target_check CHECK (
    (
      scope = 'post_create'
      AND target_kind = 'post'
      AND requested_revision IS NULL
      AND target_revision IS NOT NULL
      AND target_revision = 0
    ) OR (
      scope = 'post_edit'
      AND target_kind = 'post'
      AND requested_revision IS NOT NULL
      AND target_revision IS NOT NULL
      AND requested_revision >= 0
      AND target_revision >= requested_revision
    ) OR (
      scope = 'group_submit'
      AND target_kind = 'group_application'
      AND requested_revision IS NULL
      AND target_revision IS NULL
    ) OR (
      scope = 'group_review'
      AND target_kind IN ('group_application', 'group')
      AND requested_revision IS NULL
      AND target_revision IS NULL
    )
  ),
  CONSTRAINT post_media_claim_sets_manifest_check CHECK (
    manifest_fingerprint ~ '^[0-9a-f]{64}$'
    AND intent_fingerprint ~ '^[0-9a-f]{64}$'
    AND object_count BETWEEN 0 AND 64
  ),
  CONSTRAINT post_media_claim_sets_result_check CHECK (
    pg_catalog.jsonb_typeof(result) = 'object'
    AND pg_catalog.pg_column_size(result) BETWEEN 2 AND 262144
    AND result ? 'status'
    AND pg_catalog.jsonb_typeof(result -> 'status') = 'string'
  ),
  CONSTRAINT post_media_claim_sets_created_at_check CHECK (
    pg_catalog.isfinite(created_at)
  )
) USING heap;

CREATE TABLE IF NOT EXISTS public.post_media_claims (
  upload_id uuid NOT NULL,
  target_kind text NOT NULL,
  target_id uuid NOT NULL,
  reference_kind text NOT NULL,
  first_claim_operation_id uuid NOT NULL,
  first_seen_revision bigint,
  last_seen_revision bigint,
  claimed_at timestamptz NOT NULL DEFAULT pg_catalog.statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.statement_timestamp(),
  CONSTRAINT post_media_claims_pkey
    PRIMARY KEY (upload_id, target_kind, target_id),
  CONSTRAINT post_media_claims_upload_fkey FOREIGN KEY (upload_id)
    REFERENCES public.post_media_uploads(upload_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT post_media_claims_target_check CHECK (
    target_kind IN ('post', 'group_application', 'group')
    AND (
      (
        target_kind = 'post'
        AND reference_kind IN ('post_image', 'post_video')
        AND first_seen_revision IS NOT NULL
        AND last_seen_revision IS NOT NULL
        AND first_seen_revision >= 0
        AND last_seen_revision >= first_seen_revision
      ) OR (
        target_kind IN ('group_application', 'group')
        AND reference_kind = 'group_avatar'
        AND first_seen_revision IS NULL
        AND last_seen_revision IS NULL
      )
    )
  ),
  CONSTRAINT post_media_claims_time_check CHECK (
    pg_catalog.isfinite(claimed_at)
    AND pg_catalog.isfinite(updated_at)
    AND updated_at >= claimed_at
  )
) USING heap;

ALTER TABLE public.post_media_claim_sets OWNER TO postgres;
ALTER TABLE public.post_media_claim_sets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.post_media_claim_sets FORCE ROW LEVEL SECURITY;
ALTER TABLE public.post_media_claims OWNER TO postgres;
ALTER TABLE public.post_media_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.post_media_claims FORCE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS post_media_claim_sets_target_idx
  ON public.post_media_claim_sets (
    target_kind, target_id, target_revision, scope, operation_id
  );
CREATE INDEX IF NOT EXISTS post_media_claims_target_idx
  ON public.post_media_claims (target_kind, target_id, upload_id);

-- Pin the complete PostgreSQL 17 catalog identity. IF NOT EXISTS must never
-- bless an attacker-compatible name with an extra column, default, check, or
-- index. Digests below are reviewed pg_get_constraintdef/pg_get_indexdef
-- outputs from PostgreSQL 17 for the definitions published above.
CREATE OR REPLACE FUNCTION pg_temp.post_media_claim_tables_are_exact()
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $function$
  WITH expected_column(
    table_oid,
    column_number,
    column_name,
    type_oid,
    required_not_null,
    default_expression,
    collation_oid
  ) AS (
    VALUES
      (
        'public.post_media_claim_sets'::regclass, 1, 'scope',
        'pg_catalog.text'::regtype, true, NULL::text,
        'pg_catalog."default"'::regcollation
      ),
      (
        'public.post_media_claim_sets'::regclass, 2, 'operation_id',
        'pg_catalog.uuid'::regtype, true, NULL::text, 0::oid
      ),
      (
        'public.post_media_claim_sets'::regclass, 3, 'actor_id',
        'pg_catalog.uuid'::regtype, true, NULL::text, 0::oid
      ),
      (
        'public.post_media_claim_sets'::regclass, 4, 'target_kind',
        'pg_catalog.text'::regtype, true, NULL::text,
        'pg_catalog."default"'::regcollation
      ),
      (
        'public.post_media_claim_sets'::regclass, 5, 'target_id',
        'pg_catalog.uuid'::regtype, true, NULL::text, 0::oid
      ),
      (
        'public.post_media_claim_sets'::regclass, 6, 'requested_revision',
        'pg_catalog.int8'::regtype, false, NULL::text, 0::oid
      ),
      (
        'public.post_media_claim_sets'::regclass, 7, 'target_revision',
        'pg_catalog.int8'::regtype, false, NULL::text, 0::oid
      ),
      (
        'public.post_media_claim_sets'::regclass, 8, 'manifest_fingerprint',
        'pg_catalog.text'::regtype, true, NULL::text,
        'pg_catalog."default"'::regcollation
      ),
      (
        'public.post_media_claim_sets'::regclass, 9, 'intent_fingerprint',
        'pg_catalog.text'::regtype, true, NULL::text,
        'pg_catalog."default"'::regcollation
      ),
      (
        'public.post_media_claim_sets'::regclass, 10, 'object_count',
        'pg_catalog.int4'::regtype, true, NULL::text, 0::oid
      ),
      (
        'public.post_media_claim_sets'::regclass, 11, 'result',
        'pg_catalog.jsonb'::regtype, true, NULL::text, 0::oid
      ),
      (
        'public.post_media_claim_sets'::regclass, 12, 'created_at',
        'pg_catalog.timestamptz'::regtype, true, 'statement_timestamp()', 0::oid
      ),
      (
        'public.post_media_claims'::regclass, 1, 'upload_id',
        'pg_catalog.uuid'::regtype, true, NULL::text, 0::oid
      ),
      (
        'public.post_media_claims'::regclass, 2, 'target_kind',
        'pg_catalog.text'::regtype, true, NULL::text,
        'pg_catalog."default"'::regcollation
      ),
      (
        'public.post_media_claims'::regclass, 3, 'target_id',
        'pg_catalog.uuid'::regtype, true, NULL::text, 0::oid
      ),
      (
        'public.post_media_claims'::regclass, 4, 'reference_kind',
        'pg_catalog.text'::regtype, true, NULL::text,
        'pg_catalog."default"'::regcollation
      ),
      (
        'public.post_media_claims'::regclass, 5,
        'first_claim_operation_id', 'pg_catalog.uuid'::regtype,
        true, NULL::text, 0::oid
      ),
      (
        'public.post_media_claims'::regclass, 6, 'first_seen_revision',
        'pg_catalog.int8'::regtype, false, NULL::text, 0::oid
      ),
      (
        'public.post_media_claims'::regclass, 7, 'last_seen_revision',
        'pg_catalog.int8'::regtype, false, NULL::text, 0::oid
      ),
      (
        'public.post_media_claims'::regclass, 8, 'claimed_at',
        'pg_catalog.timestamptz'::regtype, true, 'statement_timestamp()', 0::oid
      ),
      (
        'public.post_media_claims'::regclass, 9, 'updated_at',
        'pg_catalog.timestamptz'::regtype, true, 'statement_timestamp()', 0::oid
      )
  ), actual_column AS (
    SELECT
      attribute.attrelid AS table_oid,
      attribute.attnum AS column_number,
      attribute.attname::text AS column_name,
      attribute.atttypid AS type_oid,
      attribute.attnotnull AS required_not_null,
      pg_catalog.pg_get_expr(
        default_row.adbin,
        default_row.adrelid,
        true
      ) AS default_expression,
      attribute.attcollation,
      attribute.attstorage,
      attribute.attidentity,
      attribute.attgenerated,
      attribute.atttypmod,
      attribute.attndims,
      attribute.attstattarget,
      attribute.attcompression,
      attribute.attinhcount,
      attribute.attislocal,
      attribute.atthasmissing,
      attribute.attacl,
      attribute.attoptions,
      attribute.attfdwoptions
    FROM pg_catalog.pg_attribute AS attribute
    LEFT JOIN pg_catalog.pg_attrdef AS default_row
      ON default_row.adrelid = attribute.attrelid
     AND default_row.adnum = attribute.attnum
    WHERE attribute.attrelid IN (
      'public.post_media_claim_sets'::regclass,
      'public.post_media_claims'::regclass
    )
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  ), column_contract AS (
    SELECT NOT EXISTS (
      SELECT 1
      FROM expected_column AS expected
      FULL JOIN actual_column AS actual
        USING (table_oid, column_number)
      WHERE expected.column_name IS NULL
         OR actual.column_name IS NULL
         OR actual.column_name IS DISTINCT FROM expected.column_name
         OR actual.type_oid IS DISTINCT FROM expected.type_oid
         OR actual.required_not_null IS DISTINCT FROM
              expected.required_not_null
         OR actual.default_expression IS DISTINCT FROM
              expected.default_expression
         OR actual.attcollation IS DISTINCT FROM expected.collation_oid
         OR actual.attstorage IS DISTINCT FROM CASE
              WHEN expected.type_oid IN (
                'pg_catalog.text'::regtype,
                'pg_catalog.jsonb'::regtype
              ) THEN 'x'::"char"
              ELSE 'p'::"char"
            END
         OR actual.attidentity <> ''
         OR actual.attgenerated <> ''
         OR actual.atttypmod <> -1
         OR actual.attndims <> 0
         OR actual.attstattarget <> -1
         OR actual.attcompression <> ''
         OR actual.attinhcount <> 0
         OR NOT actual.attislocal
         OR actual.atthasmissing
         OR actual.attoptions IS NOT NULL
         OR actual.attfdwoptions IS NOT NULL
    ) AS exact
  ), expected_constraint(
    table_oid,
    constraint_name,
    definition_digest
  ) AS (
    VALUES
      (
        'public.post_media_claim_sets'::regclass,
        'post_media_claim_sets_created_at_check',
        '4561a7eafede5113bcc0ff35d9b6c457'
      ),
      (
        'public.post_media_claim_sets'::regclass,
        'post_media_claim_sets_manifest_check',
        'faa53542482a106e8d4d79effbe7d74b'
      ),
      (
        'public.post_media_claim_sets'::regclass,
        'post_media_claim_sets_pkey',
        'c2e71f06b49890bc6683325e8af7ad33'
      ),
      (
        'public.post_media_claim_sets'::regclass,
        'post_media_claim_sets_result_check',
        '1969809672a253e0503d09917fa7490e'
      ),
      (
        'public.post_media_claim_sets'::regclass,
        'post_media_claim_sets_scope_check',
        '40c6eea2d5c1d2f33373d9e630b576ca'
      ),
      (
        'public.post_media_claim_sets'::regclass,
        'post_media_claim_sets_target_check',
        '64ce49b824062582822e070582ef0e3a'
      ),
      (
        'public.post_media_claims'::regclass,
        'post_media_claims_pkey',
        'ed0fcd9d5afa0637ac1f97bdbcb3c49f'
      ),
      (
        'public.post_media_claims'::regclass,
        'post_media_claims_target_check',
        '694ca2c364981b5a8c1248ef90d15dbc'
      ),
      (
        'public.post_media_claims'::regclass,
        'post_media_claims_time_check',
        'ea770bd3f19e988e2fff0eb8668b391e'
      ),
      (
        'public.post_media_claims'::regclass,
        'post_media_claims_upload_fkey',
        'ad75aadb904b4d38e7936dfe8a6b4f01'
      )
  ), constraint_contract AS (
    SELECT NOT EXISTS (
      SELECT 1
      FROM expected_constraint AS expected
      FULL JOIN (
        SELECT constraint_row.*
        FROM pg_catalog.pg_constraint AS constraint_row
        WHERE constraint_row.conrelid IN (
          'public.post_media_claim_sets'::regclass,
          'public.post_media_claims'::regclass
        )
      ) AS actual
        ON actual.conrelid = expected.table_oid
       AND actual.conname = expected.constraint_name
      WHERE actual.oid IS NULL
         OR expected.constraint_name IS NULL
         OR NOT actual.convalidated
         OR actual.condeferrable
         OR actual.condeferred
         OR NOT actual.conislocal
         OR actual.coninhcount <> 0
         OR actual.conparentid <> 0
         OR pg_catalog.md5(
              pg_catalog.pg_get_constraintdef(actual.oid, true)
            ) IS DISTINCT FROM expected.definition_digest
    ) AND (
      SELECT pg_catalog.count(*)
      FROM pg_catalog.pg_constraint AS actual
      WHERE actual.conrelid IN (
        'public.post_media_claim_sets'::regclass,
        'public.post_media_claims'::regclass
      )
    ) = 10 AS exact
  ), expected_index(
    table_oid,
    index_name,
    definition_digest,
    expected_unique,
    expected_primary,
    expected_keys
  ) AS (
    VALUES
      (
        'public.post_media_claim_sets'::regclass,
        'post_media_claim_sets_pkey',
        '62ee07e5e2dec9ebbf3e91adb540f843',
        true, true, 2
      ),
      (
        'public.post_media_claim_sets'::regclass,
        'post_media_claim_sets_target_idx',
        'f379fa238972032cde64ea942f0a356a',
        false, false, 5
      ),
      (
        'public.post_media_claims'::regclass,
        'post_media_claims_pkey',
        'a86b63baeb013ae4c0a522cafb490a08',
        true, true, 3
      ),
      (
        'public.post_media_claims'::regclass,
        'post_media_claims_target_idx',
        '1cc16c9b5c5e3487408a1568a9d55549',
        false, false, 3
      )
  ), index_contract AS (
    SELECT NOT EXISTS (
      SELECT 1
      FROM expected_index AS expected
      FULL JOIN (
        SELECT index_row.*, index_relation.relname::text AS index_name,
          access_method.amname
        FROM pg_catalog.pg_index AS index_row
        JOIN pg_catalog.pg_class AS index_relation
          ON index_relation.oid = index_row.indexrelid
        JOIN pg_catalog.pg_am AS access_method
          ON access_method.oid = index_relation.relam
        WHERE index_row.indrelid IN (
          'public.post_media_claim_sets'::regclass,
          'public.post_media_claims'::regclass
        )
      ) AS actual
        ON actual.indrelid = expected.table_oid
       AND actual.index_name = expected.index_name
      WHERE actual.indexrelid IS NULL
         OR expected.index_name IS NULL
         OR actual.amname <> 'btree'
         OR actual.indisunique IS DISTINCT FROM expected.expected_unique
         OR actual.indisprimary IS DISTINCT FROM expected.expected_primary
         OR NOT actual.indisvalid
         OR NOT actual.indisready
         OR NOT actual.indislive
         OR actual.indisexclusion
         OR actual.indimmediate IS DISTINCT FROM true
         OR actual.indisclustered
         OR actual.indisreplident
         OR actual.indpred IS NOT NULL
         OR actual.indexprs IS NOT NULL
         OR actual.indnkeyatts <> expected.expected_keys
         OR actual.indnatts <> expected.expected_keys
         OR pg_catalog.md5(
              pg_catalog.pg_get_indexdef(actual.indexrelid)
            ) IS DISTINCT FROM expected.definition_digest
    ) AND (
      SELECT pg_catalog.count(*)
      FROM pg_catalog.pg_index AS actual
      WHERE actual.indrelid IN (
        'public.post_media_claim_sets'::regclass,
        'public.post_media_claims'::regclass
      )
    ) = 4 AS exact
  )
  SELECT column_contract.exact
    AND constraint_contract.exact
    AND index_contract.exact
    AND (
      SELECT pg_catalog.count(*) = 2
        AND pg_catalog.bool_and(
          relation.relkind = 'r'
          AND relation.relpersistence = 'p'
          AND NOT relation.relispartition
          AND relation.relowner = pg_catalog.to_regrole('postgres')
          AND relation.relam = (
            SELECT access_method.oid
            FROM pg_catalog.pg_am AS access_method
            WHERE access_method.amname = 'heap'
              AND access_method.amtype = 't'
          )
          AND relation.reloptions IS NULL
        )
      FROM pg_catalog.pg_class AS relation
      WHERE relation.oid IN (
        'public.post_media_claim_sets'::regclass,
        'public.post_media_claims'::regclass
      )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_attribute AS attribute
      WHERE attribute.attrelid IN (
        'public.post_media_claim_sets'::regclass,
        'public.post_media_claims'::regclass
      )
        AND attribute.attnum > 0
        AND attribute.attisdropped
    )
  FROM column_contract, constraint_contract, index_contract
$function$;

DO $table_shape_preflight$
DECLARE
  v_relation regclass;
BEGIN
  FOREACH v_relation IN ARRAY ARRAY[
    'public.post_media_uploads'::pg_catalog.regclass,
    'public.post_media_claim_sets'::pg_catalog.regclass,
    'public.post_media_claims'::pg_catalog.regclass
  ]
  LOOP
    IF NOT (
      SELECT relation.relkind = 'r'
        AND relation.relpersistence = 'p'
        AND NOT relation.relispartition
        AND relation.relowner = pg_catalog.to_regrole('postgres')
        AND relation.relrowsecurity
        AND relation.relforcerowsecurity
      FROM pg_catalog.pg_class AS relation
      WHERE relation.oid = v_relation
    ) OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_inherits AS inheritance
      WHERE inheritance.inhrelid = v_relation
         OR inheritance.inhparent = v_relation
    ) OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_rewrite AS rewrite_rule
      WHERE rewrite_rule.ev_class = v_relation
        AND rewrite_rule.rulename <> '_RETURN'
    ) OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_trigger AS trigger_row
      WHERE trigger_row.tgrelid = v_relation
        AND NOT trigger_row.tgisinternal
    ) THEN
      RAISE EXCEPTION 'post media claim relation shape drifted: %',
        v_relation;
    END IF;
  END LOOP;

  IF NOT pg_temp.post_media_claim_tables_are_exact() THEN
    RAISE EXCEPTION 'post media claim catalog identity drifted';
  END IF;
  IF NOT pg_temp.post_media_claim_fk_triggers_are_safe(
    'public.post_media_claims'::regclass,
    'public.post_media_uploads'::regclass
  ) THEN
    RAISE EXCEPTION 'post media claim FK trigger identity drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid IN (
      'public.post_media_claim_sets'::pg_catalog.regclass,
      'public.post_media_claims'::pg_catalog.regclass
    )
      AND constraint_row.contype = 'f'
      AND (
        constraint_row.confdeltype <> 'r'
        OR constraint_row.confupdtype <> 'r'
      )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid =
        'public.post_media_claim_sets'::pg_catalog.regclass
      AND constraint_row.contype = 'f'
  ) OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid =
      'public.post_media_claims'::pg_catalog.regclass
      AND constraint_row.contype = 'f'
      AND constraint_row.confrelid =
        'public.post_media_uploads'::pg_catalog.regclass
      AND constraint_row.conkey = ARRAY[1]::smallint[]
      AND constraint_row.confkey = ARRAY[1]::smallint[]
      AND constraint_row.confdeltype = 'r'
      AND constraint_row.confupdtype = 'r'
      AND constraint_row.convalidated
      AND NOT constraint_row.condeferrable
  ) <> 1 THEN
    RAISE EXCEPTION 'post media claims must have only the RESTRICT upload edge';
  END IF;
END
$table_shape_preflight$;

DO $converge_private_table_acl$
DECLARE
  v_relation regclass;
  v_relation_name text;
  v_grantee record;
  v_columns text;
  v_policy name;
BEGIN
  IF pg_catalog.current_setting(
    'ranking_arena.post_media_claim_fresh_install', true
  ) IS DISTINCT FROM 'true' THEN
    RETURN;
  END IF;
  FOREACH v_relation IN ARRAY ARRAY[
    'public.post_media_claim_sets'::pg_catalog.regclass,
    'public.post_media_claims'::pg_catalog.regclass
  ]
  LOOP
    v_relation_name := v_relation::text;
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
      WHERE relation.oid = v_relation
        AND acl_entry.grantee <> relation.relowner
    LOOP
      IF v_grantee.grantee = 0 THEN
        EXECUTE pg_catalog.format(
          'REVOKE ALL ON TABLE %s FROM PUBLIC CASCADE', v_relation
        );
      ELSIF v_grantee.rolname IS NOT NULL THEN
        EXECUTE pg_catalog.format(
          'REVOKE ALL ON TABLE %s FROM %I CASCADE',
          v_relation,
          v_grantee.rolname
        );
      END IF;
    END LOOP;

    SELECT pg_catalog.string_agg(
      pg_catalog.format('%I', attribute.attname),
      ', ' ORDER BY attribute.attnum
    )
    INTO STRICT v_columns
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = v_relation
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped;

    FOR v_grantee IN
      SELECT DISTINCT acl_entry.grantee, role_row.rolname
      FROM pg_catalog.pg_attribute AS attribute
      CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl_entry
      LEFT JOIN pg_catalog.pg_roles AS role_row
        ON role_row.oid = acl_entry.grantee
      WHERE attribute.attrelid = v_relation
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
        AND acl_entry.grantee <> pg_catalog.to_regrole('postgres')
    LOOP
      IF v_grantee.grantee = 0 THEN
        EXECUTE pg_catalog.format(
          'REVOKE SELECT (%1$s), INSERT (%1$s), UPDATE (%1$s), '
            || 'REFERENCES (%1$s) ON TABLE %2$s FROM PUBLIC CASCADE',
          v_columns,
          v_relation
        );
      ELSIF v_grantee.rolname IS NOT NULL THEN
        EXECUTE pg_catalog.format(
          'REVOKE SELECT (%1$s), INSERT (%1$s), UPDATE (%1$s), '
            || 'REFERENCES (%1$s) ON TABLE %2$s FROM %3$I CASCADE',
          v_columns,
          v_relation,
          v_grantee.rolname
        );
      END IF;
    END LOOP;

    FOR v_policy IN
      SELECT policy.polname
      FROM pg_catalog.pg_policy AS policy
      WHERE policy.polrelid = v_relation
    LOOP
      EXECUTE pg_catalog.format(
        'DROP POLICY %I ON %s', v_policy, v_relation
      );
    END LOOP;
  END LOOP;
END
$converge_private_table_acl$;

DO $claim_authority_prepublication$
BEGIN
  IF NOT pg_temp.post_media_claim_tables_are_exact()
     OR NOT pg_temp.post_media_claim_fk_triggers_are_safe(
       'public.post_media_claims'::regclass,
       'public.post_media_uploads'::regclass
     ) OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_class AS relation
       CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(
         relation.relacl, pg_catalog.acldefault('r', relation.relowner)
       )) AS acl_entry
       WHERE relation.oid IN (
         'public.post_media_claim_sets'::regclass,
         'public.post_media_claims'::regclass
       )
         AND acl_entry.grantee <> relation.relowner
     ) OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_attribute AS attribute
       JOIN pg_catalog.pg_class AS relation
         ON relation.oid = attribute.attrelid
       CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl_entry
       WHERE attribute.attrelid IN (
         'public.post_media_claim_sets'::regclass,
         'public.post_media_claims'::regclass
       )
         AND attribute.attnum > 0
         AND NOT attribute.attisdropped
         AND acl_entry.grantee <> relation.relowner
     ) OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_policy AS policy
       WHERE policy.polrelid IN (
         'public.post_media_claim_sets'::regclass,
         'public.post_media_claims'::regclass
       )
     )
  THEN
    RAISE EXCEPTION 'post media claim prepublication authority is unsafe';
  END IF;
END
$claim_authority_prepublication$;

CREATE OR REPLACE FUNCTION public.claim_post_media_manifest_internal(
  p_scope text,
  p_operation_id uuid,
  p_actor_id uuid,
  p_media_owner_id uuid,
  p_target_kind text,
  p_target_id uuid,
  p_source_application_id uuid,
  p_requested_revision bigint,
  p_target_revision bigint,
  p_storage_origin text,
  p_media_object_names text[],
  p_intent_fingerprint text,
  p_result jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
SET lock_timeout = '5s'
SET statement_timeout = '15s'
AS $function$
DECLARE
  v_avatar_url text;
  v_check_avatar_url text;
  v_check_content text;
  v_check_content_version bigint;
  v_check_images text[];
  v_check_source_group_id uuid;
  v_check_source_status text;
  v_check_target_group_id uuid;
  v_check_target_status text;
  v_check_source_avatar_url text;
  v_claim public.post_media_claims%ROWTYPE;
  v_content text;
  v_content_version bigint;
  v_content_refs text[] := ARRAY[]::text[];
  v_existing public.post_media_claim_sets%ROWTYPE;
  v_image_refs text[] := ARRAY[]::text[];
  v_images text[];
  v_lock_name text;
  v_lock_names text[] := ARRAY[]::text[];
  v_manifest text[];
  v_manifest_fingerprint text;
  v_media_prefix text;
  v_origin_authority text;
  v_origin_scheme text;
  v_object_pattern constant text :=
    '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/'
    || '(?:videos/)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
    || '[.](?:jpg|png|gif|webp|avif|mp4|mov|webm|mkv|avi)$';
  v_storage_stem constant text := '/storage/v1/object/public/posts';
  v_reference_kind text;
  v_referenced_names text[] := ARRAY[]::text[];
  v_registered_refs text[] := ARRAY[]::text[];
  v_source_avatar_url text;
  v_source_group_id uuid;
  v_source_owner_id uuid;
  v_source_status text;
  v_source_referenced_names text[] := ARRAY[]::text[];
  v_storage_count bigint;
  v_target_group_id uuid;
  v_target_owner_id uuid;
  v_target_status text;
  v_upload public.post_media_uploads%ROWTYPE;
  v_upload_id uuid;
BEGIN
  IF p_scope IS NULL
     OR p_scope NOT IN (
       'post_create', 'post_edit', 'group_submit', 'group_review'
     )
     OR p_operation_id IS NULL
     OR p_actor_id IS NULL
     OR p_media_owner_id IS NULL
     OR p_target_kind IS NULL
     OR p_target_id IS NULL
     OR p_storage_origin IS NULL
     OR p_storage_origin IS DISTINCT FROM
       pg_catalog.lower(pg_catalog.btrim(p_storage_origin))
     OR pg_catalog.octet_length(p_storage_origin) NOT BETWEEN 8 AND 2048
     OR p_storage_origin ~ '[[:cntrl:]]'
     OR p_storage_origin ~ '[.][.]'
     OR p_storage_origin !~
       '^https?://(?:localhost|[a-z0-9](?:[a-z0-9-]{0,62})(?:[.][a-z0-9](?:[a-z0-9-]{0,62}))*)(?::[1-9][0-9]{0,4})?$'
     OR p_media_object_names IS NULL
     OR p_intent_fingerprint IS NULL
     OR p_intent_fingerprint !~ '^[0-9a-f]{64}$'
     OR pg_catalog.jsonb_typeof(p_result) IS DISTINCT FROM 'object'
     OR pg_catalog.pg_column_size(p_result) NOT BETWEEN 2 AND 262144
     OR pg_catalog.jsonb_typeof(p_result -> 'status') IS DISTINCT FROM 'string'
     OR NOT (
       (
         p_scope = 'post_create'
         AND p_target_kind = 'post'
         AND p_source_application_id IS NULL
         AND p_requested_revision IS NULL
         AND p_target_revision IS NOT NULL
         AND p_target_revision = 0
       ) OR (
         p_scope = 'post_edit'
         AND p_target_kind = 'post'
         AND p_source_application_id IS NULL
         AND p_requested_revision IS NOT NULL
         AND p_target_revision IS NOT NULL
         AND p_requested_revision >= 0
         AND p_target_revision >= p_requested_revision
       ) OR (
         p_scope = 'group_submit'
         AND p_target_kind = 'group_application'
         AND p_source_application_id IS NULL
         AND p_requested_revision IS NULL
         AND p_target_revision IS NULL
       ) OR (
         p_scope = 'group_review'
         AND p_target_kind IN ('group_application', 'group')
         AND (
           (p_target_kind = 'group_application' AND p_source_application_id IS NULL)
           OR (p_target_kind = 'group' AND p_source_application_id IS NOT NULL)
         )
         AND p_requested_revision IS NULL
         AND p_target_revision IS NULL
       )
     )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'invalid post media claim';
  END IF;

  v_media_prefix := p_storage_origin || '/storage/v1/object/public/posts/';
  v_origin_scheme := pg_catalog.lower(
    pg_catalog.split_part(p_storage_origin, '://', 1)
  );
  v_origin_authority := pg_catalog.lower(
    pg_catalog.split_part(p_storage_origin, '://', 2)
  );
  IF v_origin_scheme = 'https' THEN
    v_origin_authority := pg_catalog.regexp_replace(
      v_origin_authority, ':0*443$', ''
    );
  ELSE
    v_origin_authority := pg_catalog.regexp_replace(
      v_origin_authority, ':0*80$', ''
    );
  END IF;

  v_manifest := ARRAY(
    SELECT pg_catalog.btrim(requested.object_name)
    FROM pg_catalog.unnest(p_media_object_names) AS requested(object_name)
    ORDER BY pg_catalog.btrim(requested.object_name) COLLATE "C"
  );
  IF pg_catalog.cardinality(v_manifest) > 64
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.unnest(p_media_object_names) AS requested(object_name)
       WHERE requested.object_name IS NULL
          OR requested.object_name IS DISTINCT FROM
            pg_catalog.btrim(requested.object_name)
          OR pg_catalog.octet_length(requested.object_name) NOT BETWEEN 1 AND 512
          OR requested.object_name ~ '[[:cntrl:]]'
          OR requested.object_name ~ '(^/|/$|//|(^|/)\.{1,2}(/|$))'
     ) OR (
       SELECT pg_catalog.count(DISTINCT requested.object_name)
       FROM pg_catalog.unnest(v_manifest) AS requested(object_name)
     ) <> pg_catalog.cardinality(v_manifest)
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'invalid post media claim manifest';
  END IF;

  v_manifest_fingerprint := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_array(
      'post-media-claim-manifest:v1', v_manifest
    )::text, 'UTF8')),
    'hex'
  );

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'post-media-claim-operation:' || p_scope || ':'
        || pg_catalog.lower(p_operation_id::text),
      0
    )
  );

  SELECT claim_set.*
  INTO v_existing
  FROM public.post_media_claim_sets AS claim_set
  WHERE claim_set.scope = p_scope
    AND claim_set.operation_id = p_operation_id
  FOR UPDATE;
  IF FOUND THEN
    IF v_existing.actor_id IS DISTINCT FROM p_actor_id
       OR v_existing.target_kind IS DISTINCT FROM p_target_kind
       OR v_existing.target_id IS DISTINCT FROM p_target_id
       OR v_existing.requested_revision IS DISTINCT FROM p_requested_revision
       OR v_existing.target_revision IS DISTINCT FROM p_target_revision
       OR v_existing.manifest_fingerprint IS DISTINCT FROM
         v_manifest_fingerprint
       OR v_existing.intent_fingerprint IS DISTINCT FROM
         p_intent_fingerprint
       OR v_existing.object_count IS DISTINCT FROM
         pg_catalog.cardinality(v_manifest)
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '22023',
        MESSAGE = 'post media claim operation conflict';
    END IF;
    RETURN v_existing.result;
  END IF;

  IF p_target_kind = 'post' THEN
    SELECT target.author_id, target.images, target.content,
      target.content_version
    INTO v_target_owner_id, v_images, v_content, v_content_version
    FROM public.posts AS target
    WHERE target.id = p_target_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '22023',
        MESSAGE = 'post media claim target is unavailable';
    END IF;
    IF v_content_version IS DISTINCT FROM p_target_revision THEN
      RAISE EXCEPTION USING ERRCODE = '40001',
        MESSAGE = 'post media claim revision is stale';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM pg_catalog.unnest(COALESCE(v_images, ARRAY[]::text[]))
        AS image(image_url)
      WHERE image.image_url ~* '^https?://[^/]*@'
         OR image.image_url ~* '^https?://[^/]*%'
         OR pg_catalog.strpos(image.image_url, E'\\') > 0
         OR (
          pg_catalog.lower(pg_catalog.split_part(
            image.image_url, '://', 1
          )) = v_origin_scheme
          AND CASE
            WHEN v_origin_scheme = 'https' THEN pg_catalog.regexp_replace(
              pg_catalog.lower(pg_catalog.regexp_replace(
                pg_catalog.split_part(image.image_url, '/', 3), '^.*@', ''
              )), ':0*443$', ''
            )
            ELSE pg_catalog.regexp_replace(
              pg_catalog.lower(pg_catalog.regexp_replace(
                pg_catalog.split_part(image.image_url, '/', 3), '^.*@', ''
              )), ':0*80$', ''
            )
          END = v_origin_authority
          AND (
            pg_catalog.strpos(
              pg_catalog.lower(image.image_url), v_storage_stem
            ) > 0
            OR pg_catalog.lower(image.image_url) ~
              '/storage/v1/object/public/(?:posts|%)'
          )
          AND NOT (
            pg_catalog.left(
              image.image_url, pg_catalog.length(v_media_prefix)
            ) = v_media_prefix
            AND pg_catalog.substr(
              image.image_url, pg_catalog.length(v_media_prefix) + 1
            ) ~ v_object_pattern
          )
        )
    ) OR EXISTS (
      SELECT 1
      FROM pg_catalog.regexp_matches(
        COALESCE(v_content, ''),
        '(https?://[^[:space:]<>"''`()\[\]]+)', 'gi'
      ) AS candidate(match)
      WHERE candidate.match[1] ~* '^https?://[^/]*@'
         OR candidate.match[1] ~* '^https?://[^/]*%'
         OR (
          pg_catalog.lower(pg_catalog.split_part(
            candidate.match[1], '://', 1
          )) = v_origin_scheme
          AND CASE
            WHEN v_origin_scheme = 'https' THEN pg_catalog.regexp_replace(
              pg_catalog.lower(pg_catalog.regexp_replace(
                pg_catalog.split_part(candidate.match[1], '/', 3),
                '^.*@', ''
              )), ':0*443$', ''
            )
            ELSE pg_catalog.regexp_replace(
              pg_catalog.lower(pg_catalog.regexp_replace(
                pg_catalog.split_part(candidate.match[1], '/', 3),
                '^.*@', ''
              )), ':0*80$', ''
            )
          END = v_origin_authority
          AND (
            pg_catalog.strpos(
              pg_catalog.lower(candidate.match[1]), v_storage_stem
            ) > 0
            OR pg_catalog.lower(candidate.match[1]) ~
              '/storage/v1/object/public/(?:posts|%)'
          )
          AND NOT (
            pg_catalog.left(
              candidate.match[1], pg_catalog.length(v_media_prefix)
            ) = v_media_prefix
            AND pg_catalog.substr(
              candidate.match[1], pg_catalog.length(v_media_prefix) + 1
            ) ~ v_object_pattern
          )
        )
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '22023',
        MESSAGE = 'malformed canonical post media reference';
    END IF;

    SELECT COALESCE(pg_catalog.array_agg(
      DISTINCT candidate.object_name COLLATE "C"
      ORDER BY candidate.object_name COLLATE "C"
    ), ARRAY[]::text[])
    INTO v_image_refs
    FROM pg_catalog.unnest(COALESCE(v_images, ARRAY[]::text[]))
      AS image(image_url)
    CROSS JOIN LATERAL (
      SELECT pg_catalog.substr(
        image.image_url, pg_catalog.length(v_media_prefix) + 1
      ) AS object_name
      WHERE pg_catalog.left(
        image.image_url, pg_catalog.length(v_media_prefix)
      ) = v_media_prefix
    ) AS candidate
    WHERE candidate.object_name ~ v_object_pattern;

    SELECT COALESCE(pg_catalog.array_agg(
      DISTINCT candidate.object_name COLLATE "C"
      ORDER BY candidate.object_name COLLATE "C"
    ), ARRAY[]::text[])
    INTO v_content_refs
    FROM pg_catalog.regexp_matches(
      COALESCE(v_content, ''),
      '(https?://[^[:space:]<>"''`()\[\]]+)', 'gi'
    ) AS extracted(match)
    CROSS JOIN LATERAL (
      SELECT pg_catalog.substr(
        extracted.match[1], pg_catalog.length(v_media_prefix) + 1
      ) AS object_name
      WHERE pg_catalog.left(
        extracted.match[1], pg_catalog.length(v_media_prefix)
      ) = v_media_prefix
    ) AS candidate
    WHERE candidate.object_name ~ v_object_pattern;
  ELSIF p_target_kind = 'group_application' THEN
    SELECT target.applicant_id, target.avatar_url, target.status,
      target.group_id
    INTO v_target_owner_id, v_avatar_url, v_target_status, v_target_group_id
    FROM public.group_applications AS target
    WHERE target.id = p_target_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '22023',
        MESSAGE = 'group application media claim target is unavailable';
    END IF;
    IF (p_scope = 'group_submit' AND (
          v_target_status IS DISTINCT FROM 'pending'
          OR v_target_group_id IS NOT NULL
        )) OR (p_scope = 'group_review' AND (
          v_target_status IS DISTINCT FROM 'rejected'
          OR v_target_group_id IS NOT NULL
        ))
    THEN
      RAISE EXCEPTION USING ERRCODE = '22023',
        MESSAGE = 'group application claim state conflict';
    END IF;
  ELSE
    SELECT target.created_by, target.avatar_url
    INTO v_target_owner_id, v_avatar_url
    FROM public.groups AS target
    WHERE target.id = p_target_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '22023',
        MESSAGE = 'group media claim target is unavailable';
    END IF;
  END IF;

  IF p_source_application_id IS NOT NULL THEN
    SELECT source.applicant_id, source.avatar_url, source.status,
      source.group_id
    INTO v_source_owner_id, v_source_avatar_url, v_source_status,
      v_source_group_id
    FROM public.group_applications AS source
    WHERE source.id = p_source_application_id;
    IF NOT FOUND OR v_source_owner_id IS DISTINCT FROM p_media_owner_id THEN
      RAISE EXCEPTION USING ERRCODE = '22023',
        MESSAGE = 'source group application media claim is unavailable';
    END IF;
    IF v_source_status IS DISTINCT FROM 'approved'
       OR v_source_group_id IS DISTINCT FROM p_target_id
    THEN
      RAISE EXCEPTION USING ERRCODE = '22023',
        MESSAGE = 'approved group application link conflict';
    END IF;
  END IF;

  IF (
    v_avatar_url IS NOT NULL
    AND (
      v_avatar_url ~* '^https?://[^/]*@'
      OR v_avatar_url ~* '^https?://[^/]*%'
      OR pg_catalog.strpos(v_avatar_url, E'\\') > 0
      OR (
        pg_catalog.lower(pg_catalog.split_part(
          v_avatar_url, '://', 1
        )) = v_origin_scheme
        AND CASE
          WHEN v_origin_scheme = 'https' THEN pg_catalog.regexp_replace(
            pg_catalog.lower(pg_catalog.regexp_replace(
              pg_catalog.split_part(v_avatar_url, '/', 3), '^.*@', ''
            )), ':0*443$', ''
          )
          ELSE pg_catalog.regexp_replace(
            pg_catalog.lower(pg_catalog.regexp_replace(
              pg_catalog.split_part(v_avatar_url, '/', 3), '^.*@', ''
            )), ':0*80$', ''
          )
        END = v_origin_authority
        AND (
          pg_catalog.strpos(
            pg_catalog.lower(v_avatar_url), v_storage_stem
          ) > 0
          OR pg_catalog.lower(v_avatar_url) ~
            '/storage/v1/object/public/(?:posts|%)'
        )
        AND NOT (
          pg_catalog.left(v_avatar_url, pg_catalog.length(v_media_prefix))
            = v_media_prefix
          AND pg_catalog.substr(
            v_avatar_url, pg_catalog.length(v_media_prefix) + 1
          ) ~ v_object_pattern
        )
      )
    )
  ) OR (
    v_source_avatar_url IS NOT NULL
    AND (
      v_source_avatar_url ~* '^https?://[^/]*@'
      OR v_source_avatar_url ~* '^https?://[^/]*%'
      OR pg_catalog.strpos(v_source_avatar_url, E'\\') > 0
      OR (
        pg_catalog.lower(pg_catalog.split_part(
          v_source_avatar_url, '://', 1
        )) = v_origin_scheme
        AND CASE
          WHEN v_origin_scheme = 'https' THEN pg_catalog.regexp_replace(
            pg_catalog.lower(pg_catalog.regexp_replace(
              pg_catalog.split_part(v_source_avatar_url, '/', 3),
              '^.*@', ''
            )), ':0*443$', ''
          )
          ELSE pg_catalog.regexp_replace(
            pg_catalog.lower(pg_catalog.regexp_replace(
              pg_catalog.split_part(v_source_avatar_url, '/', 3),
              '^.*@', ''
            )), ':0*80$', ''
          )
        END = v_origin_authority
        AND (
          pg_catalog.strpos(
            pg_catalog.lower(v_source_avatar_url), v_storage_stem
          ) > 0
          OR pg_catalog.lower(v_source_avatar_url) ~
            '/storage/v1/object/public/(?:posts|%)'
        )
        AND NOT (
          pg_catalog.left(
            v_source_avatar_url, pg_catalog.length(v_media_prefix)
          ) = v_media_prefix
          AND pg_catalog.substr(
            v_source_avatar_url, pg_catalog.length(v_media_prefix) + 1
          ) ~ v_object_pattern
        )
      )
    )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'malformed canonical post media reference';
  END IF;

  IF v_target_owner_id IS DISTINCT FROM p_media_owner_id THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'post media claim target owner conflict';
  END IF;
  IF p_target_kind = 'post'
     AND p_actor_id IS DISTINCT FROM p_media_owner_id
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'post media claim actor conflict';
  END IF;

  IF p_target_kind IN ('group_application', 'group')
     AND v_avatar_url IS NOT NULL
  THEN
    IF pg_catalog.left(v_avatar_url, pg_catalog.length(v_media_prefix))
         = v_media_prefix
       AND pg_catalog.substr(
         v_avatar_url, pg_catalog.length(v_media_prefix) + 1
       ) ~ v_object_pattern
    THEN
      v_referenced_names := ARRAY[pg_catalog.substr(
        v_avatar_url, pg_catalog.length(v_media_prefix) + 1
      )];
    END IF;
  ELSE
    SELECT COALESCE(
      pg_catalog.array_agg(
        DISTINCT reference.object_name COLLATE "C"
        ORDER BY reference.object_name COLLATE "C"
      ),
      ARRAY[]::text[]
    )
    INTO v_referenced_names
    FROM (
      SELECT image_ref AS object_name
      FROM pg_catalog.unnest(v_image_refs) AS image_ref
      UNION
      SELECT content_ref
      FROM pg_catalog.unnest(v_content_refs) AS content_ref
    ) AS reference;
  END IF;

  IF v_source_avatar_url IS NOT NULL
     AND pg_catalog.left(
       v_source_avatar_url, pg_catalog.length(v_media_prefix)
     ) = v_media_prefix
     AND pg_catalog.substr(
       v_source_avatar_url, pg_catalog.length(v_media_prefix) + 1
     ) ~ v_object_pattern
  THEN
    v_source_referenced_names := ARRAY[pg_catalog.substr(
      v_source_avatar_url, pg_catalog.length(v_media_prefix) + 1
    )];
  END IF;

  IF p_source_application_id IS NOT NULL
     AND v_source_referenced_names IS DISTINCT FROM v_referenced_names
  THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'reviewed application and group media references conflict';
  END IF;

  SELECT COALESCE(pg_catalog.array_agg(
    DISTINCT reference.object_name COLLATE "C"
    ORDER BY reference.object_name COLLATE "C"
  ), ARRAY[]::text[])
  INTO v_referenced_names
  FROM (
    SELECT object_name
    FROM pg_catalog.unnest(v_referenced_names) AS target_ref(object_name)
    UNION
    SELECT object_name
    FROM pg_catalog.unnest(v_source_referenced_names) AS source_ref(object_name)
  ) AS reference;

  SELECT COALESCE(
    pg_catalog.array_agg(
      DISTINCT lock_name.object_name COLLATE "C"
      ORDER BY lock_name.object_name COLLATE "C"
    ),
    ARRAY[]::text[]
  )
  INTO v_lock_names
  FROM (
    SELECT object_name
    FROM pg_catalog.unnest(v_manifest) AS manifest(object_name)
    UNION
    SELECT object_name
    FROM pg_catalog.unnest(v_referenced_names) AS reference(object_name)
  ) AS lock_name;

  -- Global media lock order is immutable: every known upload-id advisory,
  -- then every object-name advisory, then registry/claim/target rows.
  FOR v_upload_id IN
    SELECT upload_row.upload_id
    FROM public.post_media_uploads AS upload_row
    WHERE upload_row.object_name = ANY(v_lock_names)
    ORDER BY upload_row.upload_id
  LOOP
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'post-media-upload-id:' || pg_catalog.lower(v_upload_id::text),
        0
      )
    );
  END LOOP;

  FOREACH v_lock_name IN ARRAY v_lock_names
  LOOP
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('post-media-object:' || v_lock_name, 0)
    );
  END LOOP;

  PERFORM upload_row.upload_id
  FROM public.post_media_uploads AS upload_row
  WHERE upload_row.object_name = ANY(v_lock_names)
  ORDER BY upload_row.upload_id
  FOR UPDATE;

  -- Storage durability is attested after the canonical upload/object advisory
  -- sequence and registry row locks. This is a read-only identity lock.
  PERFORM storage_row.name
  FROM storage.objects AS storage_row
  WHERE storage_row.bucket_id = 'posts'
    AND storage_row.name = ANY(v_manifest)
  ORDER BY storage_row.name COLLATE "C"
  FOR SHARE;
  GET DIAGNOSTICS v_storage_count = ROW_COUNT;
  IF v_storage_count IS DISTINCT FROM pg_catalog.cardinality(v_manifest)::bigint
  THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'post media Storage object is unavailable';
  END IF;

  IF p_source_application_id IS NOT NULL THEN
    SELECT source.avatar_url, source.status, source.group_id
    INTO v_check_source_avatar_url, v_check_source_status,
      v_check_source_group_id
    FROM public.group_applications AS source
    WHERE source.id = p_source_application_id
      AND source.applicant_id = p_media_owner_id
    FOR SHARE;
    IF NOT FOUND
       OR v_check_source_avatar_url IS DISTINCT FROM v_source_avatar_url
       OR v_check_source_status IS DISTINCT FROM v_source_status
       OR v_check_source_group_id IS DISTINCT FROM v_source_group_id
    THEN
      RAISE EXCEPTION USING ERRCODE = '40001',
        MESSAGE = 'source group application changed before its lock';
    END IF;
  END IF;

  IF p_target_kind = 'post' THEN
    SELECT target.images, target.content, target.content_version
    INTO v_check_images, v_check_content, v_check_content_version
    FROM public.posts AS target
    WHERE target.id = p_target_id
      AND target.author_id = p_media_owner_id
    FOR SHARE;
    IF NOT FOUND
       OR v_check_images IS DISTINCT FROM v_images
       OR v_check_content IS DISTINCT FROM v_content
       OR v_check_content_version IS DISTINCT FROM v_content_version
       OR v_check_content_version IS DISTINCT FROM p_target_revision
    THEN
      RAISE EXCEPTION USING ERRCODE = '40001',
        MESSAGE = 'post media claim target changed before its canonical lock';
    END IF;
  ELSIF p_target_kind = 'group_application' THEN
    SELECT target.avatar_url, target.status, target.group_id
    INTO v_check_avatar_url, v_check_target_status, v_check_target_group_id
    FROM public.group_applications AS target
    WHERE target.id = p_target_id
      AND target.applicant_id = p_media_owner_id
    FOR SHARE;
    IF NOT FOUND
       OR v_check_avatar_url IS DISTINCT FROM v_avatar_url
       OR v_check_target_status IS DISTINCT FROM v_target_status
       OR v_check_target_group_id IS DISTINCT FROM v_target_group_id
    THEN
      RAISE EXCEPTION USING ERRCODE = '40001',
        MESSAGE = 'group application claim target changed before its lock';
    END IF;
  ELSE
    SELECT target.avatar_url
    INTO v_check_avatar_url
    FROM public.groups AS target
    WHERE target.id = p_target_id
      AND target.created_by = p_media_owner_id
    FOR SHARE;
    IF NOT FOUND OR v_check_avatar_url IS DISTINCT FROM v_avatar_url THEN
      RAISE EXCEPTION USING ERRCODE = '40001',
        MESSAGE = 'group claim target changed before its canonical lock';
    END IF;
  END IF;

  IF v_referenced_names IS DISTINCT FROM v_manifest THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'post media manifest does not exactly match canonical references';
  END IF;

  SELECT COALESCE(
    pg_catalog.array_agg(
      upload_row.object_name
      ORDER BY upload_row.object_name COLLATE "C"
    ),
    ARRAY[]::text[]
  )
  INTO v_registered_refs
  FROM public.post_media_uploads AS upload_row
  WHERE upload_row.object_name = ANY(v_referenced_names);

  IF v_registered_refs IS DISTINCT FROM v_manifest THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'post media manifest does not exactly match registered references';
  END IF;

  FOR v_upload IN
    SELECT upload_row.*
    FROM public.post_media_uploads AS upload_row
    WHERE upload_row.object_name = ANY(v_manifest)
    ORDER BY upload_row.upload_id
  LOOP
    IF v_upload.owner_id IS DISTINCT FROM p_media_owner_id
       OR v_upload.status IS DISTINCT FROM 'uploaded'
       OR v_upload.gc_admitted_at IS NOT NULL
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '22023',
        MESSAGE = 'post media upload is not claimable';
    END IF;

    IF p_target_kind = 'post' THEN
      IF v_upload.purpose IN ('post_image', 'legacy_image')
         AND (
           v_upload.object_name = ANY(v_image_refs)
           OR v_upload.object_name = ANY(v_content_refs)
         )
      THEN
        v_reference_kind := 'post_image';
      ELSIF v_upload.purpose = 'post_video'
            AND v_upload.object_name = ANY(v_content_refs)
            AND NOT v_upload.object_name = ANY(v_image_refs)
      THEN
        v_reference_kind := 'post_video';
      ELSE
        RAISE EXCEPTION USING
          ERRCODE = '22023',
          MESSAGE = 'post media purpose/reference conflict';
      END IF;
    ELSIF v_upload.purpose IN ('group_avatar', 'legacy_image')
          AND v_upload.object_name = ANY(v_referenced_names)
    THEN
      v_reference_kind := 'group_avatar';
    ELSE
      RAISE EXCEPTION USING
        ERRCODE = '22023',
        MESSAGE = 'group media purpose/reference conflict';
    END IF;

    IF p_source_application_id IS NOT NULL THEN
      SELECT claim_row.*
      INTO v_claim
      FROM public.post_media_claims AS claim_row
      WHERE claim_row.upload_id = v_upload.upload_id
        AND claim_row.target_kind = 'group_application'
        AND claim_row.target_id = p_source_application_id
      FOR UPDATE;
      IF FOUND THEN
        IF v_claim.reference_kind IS DISTINCT FROM 'group_avatar' THEN
          RAISE EXCEPTION USING ERRCODE = '22023',
            MESSAGE = 'source group application reference kind conflict';
        END IF;
        UPDATE public.post_media_claims
        SET updated_at = pg_catalog.statement_timestamp()
        WHERE upload_id = v_upload.upload_id
          AND target_kind = 'group_application'
          AND target_id = p_source_application_id;
      ELSE
        INSERT INTO public.post_media_claims (
          upload_id, target_kind, target_id, reference_kind,
          first_claim_operation_id, first_seen_revision, last_seen_revision
        ) VALUES (
          v_upload.upload_id, 'group_application', p_source_application_id,
          'group_avatar', p_operation_id, NULL, NULL
        );
      END IF;
    END IF;

    SELECT claim_row.*
    INTO v_claim
    FROM public.post_media_claims AS claim_row
    WHERE claim_row.upload_id = v_upload.upload_id
      AND claim_row.target_kind = p_target_kind
      AND claim_row.target_id = p_target_id
    FOR UPDATE;

    IF FOUND THEN
      IF v_claim.reference_kind IS DISTINCT FROM v_reference_kind THEN
        RAISE EXCEPTION USING
          ERRCODE = '22023',
          MESSAGE = 'post media reference kind conflict';
      END IF;

      UPDATE public.post_media_claims
      SET first_seen_revision = CASE
            WHEN p_target_kind = 'post' THEN LEAST(
              first_seen_revision, p_target_revision
            )
            ELSE NULL
          END,
          last_seen_revision = CASE
            WHEN p_target_kind = 'post' THEN GREATEST(
              last_seen_revision, p_target_revision
            )
            ELSE NULL
          END,
          updated_at = pg_catalog.statement_timestamp()
      WHERE upload_id = v_upload.upload_id
        AND target_kind = p_target_kind
        AND target_id = p_target_id;
    ELSE
      INSERT INTO public.post_media_claims (
        upload_id,
        target_kind,
        target_id,
        reference_kind,
        first_claim_operation_id,
        first_seen_revision,
        last_seen_revision
      ) VALUES (
        v_upload.upload_id,
        p_target_kind,
        p_target_id,
        v_reference_kind,
        p_operation_id,
        CASE WHEN p_target_kind = 'post' THEN p_target_revision END,
        CASE WHEN p_target_kind = 'post' THEN p_target_revision END
      );
    END IF;
  END LOOP;

  IF (
    SELECT pg_catalog.count(*)
    FROM public.post_media_uploads AS upload_row
    WHERE upload_row.object_name = ANY(v_manifest)
  ) IS DISTINCT FROM pg_catalog.cardinality(v_manifest)::bigint THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'post media claim manifest is incomplete';
  END IF;

  INSERT INTO public.post_media_claim_sets (
    scope,
    operation_id,
    actor_id,
    target_kind,
    target_id,
    requested_revision,
    target_revision,
    manifest_fingerprint,
    intent_fingerprint,
    object_count,
    result
  ) VALUES (
    p_scope,
    p_operation_id,
    p_actor_id,
    p_target_kind,
    p_target_id,
    p_requested_revision,
    p_target_revision,
    v_manifest_fingerprint,
    p_intent_fingerprint,
    pg_catalog.cardinality(v_manifest),
    p_result
  );

  RETURN p_result;
END
$function$;

CREATE OR REPLACE FUNCTION public.create_post_with_media_claims_atomic(
  p_actor_id uuid,
  p_operation_id uuid,
  p_title text,
  p_content text,
  p_group_id uuid,
  p_images text[],
  p_poll_enabled boolean,
  p_poll_option_texts text[],
  p_poll_type text,
  p_poll_duration_hours integer,
  p_visibility text,
  p_is_sensitive boolean,
  p_content_warning text,
  p_language text,
  p_mention_handles text[],
  p_hashtag_tags text[],
  p_media_object_names text[],
  p_storage_origin text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
SET lock_timeout = '5s'
SET statement_timeout = '15s'
AS $function$
DECLARE
  v_existing public.post_media_claim_sets%ROWTYPE;
  v_intent_fingerprint text;
  v_manifest text[];
  v_manifest_fingerprint text;
  v_result jsonb;
  v_target_id uuid;
  v_target_revision bigint;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'service role required';
  END IF;
  IF NOT pg_catalog.pg_try_advisory_xact_lock_shared(
    pg_catalog.hashtextextended('public-post-media-claims@1', 0)
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '55P03',
      MESSAGE = 'post media claims migration is active';
  END IF;
  IF p_operation_id IS NULL OR p_media_object_names IS NULL
     OR p_storage_origin IS NULL
     OR p_storage_origin IS DISTINCT FROM
       pg_catalog.lower(pg_catalog.btrim(p_storage_origin))
     OR pg_catalog.octet_length(p_storage_origin) NOT BETWEEN 8 AND 2048
     OR p_storage_origin ~ '[[:cntrl:]]'
     OR p_storage_origin ~ '[.][.]'
     OR p_storage_origin !~
       '^https?://(?:localhost|[a-z0-9](?:[a-z0-9-]{0,62})(?:[.][a-z0-9](?:[a-z0-9-]{0,62}))*)(?::[1-9][0-9]{0,4})?$'
  THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'post media claim operation and manifest are required';
  END IF;

  v_manifest := ARRAY(
    SELECT pg_catalog.btrim(requested.object_name)
    FROM pg_catalog.unnest(p_media_object_names) AS requested(object_name)
    ORDER BY pg_catalog.btrim(requested.object_name) COLLATE "C"
  );
  IF pg_catalog.cardinality(v_manifest) > 64
     OR EXISTS (
       SELECT 1 FROM pg_catalog.unnest(p_media_object_names) AS requested(object_name)
       WHERE requested.object_name IS NULL
          OR requested.object_name IS DISTINCT FROM pg_catalog.btrim(requested.object_name)
     ) OR (
       SELECT pg_catalog.count(DISTINCT requested.object_name)
       FROM pg_catalog.unnest(v_manifest) AS requested(object_name)
     ) <> pg_catalog.cardinality(v_manifest)
  THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'invalid post media claim manifest';
  END IF;
  v_manifest_fingerprint := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_array(
      'post-media-claim-manifest:v1', v_manifest
    )::text, 'UTF8')), 'hex'
  );
  v_intent_fingerprint := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_array(
      'create-post-with-media-claims:v1', p_actor_id, p_title, p_content,
      p_group_id, p_images, p_poll_enabled, p_poll_option_texts, p_poll_type,
      p_poll_duration_hours, p_visibility, p_is_sensitive, p_content_warning,
      p_language, p_mention_handles, p_hashtag_tags, p_storage_origin
    )::text, 'UTF8')), 'hex'
  );

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'post-media-claim-operation:post_create:'
        || pg_catalog.lower(p_operation_id::text), 0
    )
  );
  v_result := public.create_post_atomic(
    p_actor_id, p_operation_id, p_title, p_content, p_group_id, p_images,
    p_poll_enabled, p_poll_option_texts, p_poll_type, p_poll_duration_hours,
    p_visibility, p_is_sensitive, p_content_warning, p_language,
    p_mention_handles, p_hashtag_tags
  );
  IF v_result ->> 'status' NOT IN ('created', 'replayed') THEN
    RETURN v_result;
  END IF;

  BEGIN
    v_target_id := (v_result #>> '{post,id}')::uuid;
    v_target_revision := (v_result #>> '{post,content_version}')::bigint;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'post create media claim acknowledgement is invalid';
  END;
  IF v_target_id IS NULL OR v_target_revision <> 0 THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'post create media claim acknowledgement is invalid';
  END IF;

  -- The legacy authority takes every business-table lock before this wrapper
  -- touches the private claim ledger. This is also the migration lock order;
  -- any later conflict raises and rolls the legacy write back atomically.
  SELECT claim_set.* INTO v_existing
  FROM public.post_media_claim_sets AS claim_set
  WHERE claim_set.scope = 'post_create'
    AND claim_set.operation_id = p_operation_id
  FOR SHARE;
  IF FOUND AND (
    v_existing.actor_id IS DISTINCT FROM p_actor_id
    OR v_existing.manifest_fingerprint IS DISTINCT FROM v_manifest_fingerprint
    OR v_existing.intent_fingerprint IS DISTINCT FROM v_intent_fingerprint
    OR v_existing.object_count IS DISTINCT FROM pg_catalog.cardinality(v_manifest)
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'post media claim operation conflict';
  END IF;

  IF v_existing.scope IS NOT NULL THEN
    IF v_existing.target_kind IS DISTINCT FROM 'post'
       OR v_existing.target_id IS DISTINCT FROM v_target_id
       OR v_existing.requested_revision IS NOT NULL
       OR v_existing.target_revision IS DISTINCT FROM v_target_revision
    THEN
      RAISE EXCEPTION USING ERRCODE = '22023',
        MESSAGE = 'post media claim target conflict';
    END IF;
    RETURN v_result;
  END IF;

  PERFORM public.claim_post_media_manifest_internal(
    'post_create', p_operation_id, p_actor_id, p_actor_id, 'post',
    v_target_id, NULL, NULL, v_target_revision, p_storage_origin, v_manifest,
    v_intent_fingerprint, v_result
  );
  RETURN v_result;
END
$function$;

CREATE OR REPLACE FUNCTION public.edit_post_with_media_claims_atomic(
  p_actor_id uuid,
  p_post_id uuid,
  p_expected_version bigint,
  p_title text,
  p_content text,
  p_update_images boolean,
  p_images text[],
  p_language text,
  p_mention_handles text[],
  p_hashtag_tags text[],
  p_media_object_names text[],
  p_operation_id uuid,
  p_storage_origin text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
SET lock_timeout = '5s'
SET statement_timeout = '15s'
AS $function$
DECLARE
  v_existing public.post_media_claim_sets%ROWTYPE;
  v_intent_fingerprint text;
  v_manifest text[];
  v_manifest_fingerprint text;
  v_result jsonb;
  v_target_revision bigint;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'service role required';
  END IF;
  IF NOT pg_catalog.pg_try_advisory_xact_lock_shared(
    pg_catalog.hashtextextended('public-post-media-claims@1', 0)
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '55P03',
      MESSAGE = 'post media claims migration is active';
  END IF;
  IF p_operation_id IS NULL OR p_media_object_names IS NULL
     OR p_storage_origin IS NULL
     OR p_storage_origin IS DISTINCT FROM
       pg_catalog.lower(pg_catalog.btrim(p_storage_origin))
     OR pg_catalog.octet_length(p_storage_origin) NOT BETWEEN 8 AND 2048
     OR p_storage_origin ~ '[[:cntrl:]]'
     OR p_storage_origin ~ '[.][.]'
     OR p_storage_origin !~
       '^https?://(?:localhost|[a-z0-9](?:[a-z0-9-]{0,62})(?:[.][a-z0-9](?:[a-z0-9-]{0,62}))*)(?::[1-9][0-9]{0,4})?$'
  THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'post media claim operation and manifest are required';
  END IF;

  v_manifest := ARRAY(
    SELECT pg_catalog.btrim(requested.object_name)
    FROM pg_catalog.unnest(p_media_object_names) AS requested(object_name)
    ORDER BY pg_catalog.btrim(requested.object_name) COLLATE "C"
  );
  IF pg_catalog.cardinality(v_manifest) > 64
     OR EXISTS (
       SELECT 1 FROM pg_catalog.unnest(p_media_object_names) AS requested(object_name)
       WHERE requested.object_name IS NULL
          OR requested.object_name IS DISTINCT FROM pg_catalog.btrim(requested.object_name)
     ) OR (
       SELECT pg_catalog.count(DISTINCT requested.object_name)
       FROM pg_catalog.unnest(v_manifest) AS requested(object_name)
     ) <> pg_catalog.cardinality(v_manifest)
  THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'invalid post media claim manifest';
  END IF;
  v_manifest_fingerprint := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_array(
      'post-media-claim-manifest:v1', v_manifest
    )::text, 'UTF8')), 'hex'
  );
  v_intent_fingerprint := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_array(
      'edit-post-with-media-claims:v1', p_actor_id, p_post_id,
      p_expected_version, p_title, p_content, p_update_images, p_images,
      p_language, p_mention_handles, p_hashtag_tags, p_storage_origin
    )::text, 'UTF8')), 'hex'
  );

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'post-media-claim-operation:post_edit:'
        || pg_catalog.lower(p_operation_id::text), 0
    )
  );
  SELECT claim_set.* INTO v_existing
  FROM public.post_media_claim_sets AS claim_set
  WHERE claim_set.scope = 'post_edit'
    AND claim_set.operation_id = p_operation_id
  FOR SHARE;
  IF FOUND THEN
    IF v_existing.actor_id IS DISTINCT FROM p_actor_id
       OR v_existing.target_kind IS DISTINCT FROM 'post'
       OR v_existing.target_id IS DISTINCT FROM p_post_id
       OR v_existing.requested_revision IS DISTINCT FROM p_expected_version
       OR v_existing.manifest_fingerprint IS DISTINCT FROM v_manifest_fingerprint
       OR v_existing.intent_fingerprint IS DISTINCT FROM v_intent_fingerprint
       OR v_existing.object_count IS DISTINCT FROM pg_catalog.cardinality(v_manifest)
    THEN
      RAISE EXCEPTION USING ERRCODE = '22023',
        MESSAGE = 'post media claim operation conflict';
    END IF;
    RETURN v_existing.result;
  END IF;

  v_result := public.edit_post_atomic(
    p_actor_id, p_post_id, p_expected_version, p_title, p_content,
    p_update_images, p_images, p_language, p_mention_handles, p_hashtag_tags
  );

  IF v_result ->> 'status' NOT IN ('updated', 'unchanged') THEN
    RETURN v_result;
  END IF;
  BEGIN
    IF (v_result #>> '{post,id}')::uuid IS DISTINCT FROM p_post_id
       OR (v_result ->> 'actor_id')::uuid IS DISTINCT FROM p_actor_id
    THEN
      RAISE EXCEPTION 'invalid';
    END IF;
    v_target_revision := (v_result #>> '{post,content_version}')::bigint;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'post edit media claim acknowledgement is invalid';
  END;
  IF v_target_revision IS NULL OR (
    CASE v_result ->> 'status'
      WHEN 'updated' THEN CASE
        WHEN p_expected_version < 9223372036854775807
          THEN v_target_revision = p_expected_version + 1
        ELSE false
      END
      WHEN 'unchanged' THEN CASE
        WHEN v_target_revision = p_expected_version THEN true
        WHEN p_expected_version < 9223372036854775807
          THEN v_target_revision = p_expected_version + 1
        ELSE false
      END
      ELSE false
    END
  ) IS NOT TRUE THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'post edit media claim acknowledgement is invalid';
  END IF;

  PERFORM public.claim_post_media_manifest_internal(
    'post_edit', p_operation_id, p_actor_id, p_actor_id, 'post', p_post_id,
    NULL, p_expected_version, v_target_revision, p_storage_origin, v_manifest,
    v_intent_fingerprint, v_result
  );
  RETURN v_result;
END
$function$;

CREATE OR REPLACE FUNCTION public.submit_group_application_with_media_claims_atomic(
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
  p_promo_unlocked boolean DEFAULT false,
  p_operation_id uuid DEFAULT NULL,
  p_media_object_names text[] DEFAULT ARRAY[]::text[],
  p_storage_origin text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
SET lock_timeout = '5s'
SET statement_timeout = '15s'
AS $function$
DECLARE
  v_existing public.post_media_claim_sets%ROWTYPE;
  v_intent_fingerprint text;
  v_manifest text[];
  v_manifest_fingerprint text;
  v_result jsonb;
  v_target_id uuid;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'service role required';
  END IF;
  IF NOT pg_catalog.pg_try_advisory_xact_lock_shared(
    pg_catalog.hashtextextended('public-post-media-claims@1', 0)
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '55P03',
      MESSAGE = 'post media claims migration is active';
  END IF;
  IF p_operation_id IS NULL OR p_media_object_names IS NULL
     OR p_storage_origin IS NULL
     OR p_storage_origin IS DISTINCT FROM
       pg_catalog.lower(pg_catalog.btrim(p_storage_origin))
     OR pg_catalog.octet_length(p_storage_origin) NOT BETWEEN 8 AND 2048
     OR p_storage_origin ~ '[[:cntrl:]]'
     OR p_storage_origin ~ '[.][.]'
     OR p_storage_origin !~
       '^https?://(?:localhost|[a-z0-9](?:[a-z0-9-]{0,62})(?:[.][a-z0-9](?:[a-z0-9-]{0,62}))*)(?::[1-9][0-9]{0,4})?$'
  THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'group media claim operation and manifest are required';
  END IF;
  v_manifest := ARRAY(
    SELECT pg_catalog.btrim(requested.object_name)
    FROM pg_catalog.unnest(p_media_object_names) AS requested(object_name)
    ORDER BY pg_catalog.btrim(requested.object_name) COLLATE "C"
  );
  IF pg_catalog.cardinality(v_manifest) > 1
     OR EXISTS (
       SELECT 1 FROM pg_catalog.unnest(p_media_object_names) AS requested(object_name)
       WHERE requested.object_name IS NULL
          OR requested.object_name IS DISTINCT FROM pg_catalog.btrim(requested.object_name)
     ) OR (
       SELECT pg_catalog.count(DISTINCT requested.object_name)
       FROM pg_catalog.unnest(v_manifest) AS requested(object_name)
     ) <> pg_catalog.cardinality(v_manifest)
  THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'invalid group avatar claim manifest';
  END IF;
  v_manifest_fingerprint := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_array(
      'post-media-claim-manifest:v1', v_manifest
    )::text, 'UTF8')), 'hex'
  );
  v_intent_fingerprint := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_array(
      'submit-group-with-media-claims:v1', p_actor_id, p_name, p_name_en,
      p_description, p_description_en, p_avatar_url, p_role_names,
      p_rules_json, p_rules, p_is_premium_only, p_promo_unlocked,
      p_storage_origin
    )::text, 'UTF8')), 'hex'
  );

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'post-media-claim-operation:group_submit:'
        || pg_catalog.lower(p_operation_id::text), 0
    )
  );
  v_result := public.submit_group_application_atomic(
    p_actor_id, p_name, p_name_en, p_description, p_description_en,
    p_avatar_url, p_role_names, p_rules_json, p_rules, p_is_premium_only,
    p_promo_unlocked, p_operation_id
  );
  IF v_result ->> 'status' <> 'submitted' THEN
    RETURN v_result;
  END IF;
  BEGIN
    v_target_id := (v_result ->> 'application_id')::uuid;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'group application media claim acknowledgement is invalid';
  END;
  IF v_target_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'group application media claim acknowledgement is invalid';
  END IF;

  SELECT claim_set.* INTO v_existing
  FROM public.post_media_claim_sets AS claim_set
  WHERE claim_set.scope = 'group_submit'
    AND claim_set.operation_id = p_operation_id
  FOR SHARE;
  IF FOUND AND (
    v_existing.actor_id IS DISTINCT FROM p_actor_id
    OR v_existing.manifest_fingerprint IS DISTINCT FROM v_manifest_fingerprint
    OR v_existing.intent_fingerprint IS DISTINCT FROM v_intent_fingerprint
    OR v_existing.object_count IS DISTINCT FROM pg_catalog.cardinality(v_manifest)
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'group media claim operation conflict';
  END IF;

  IF v_existing.scope IS NOT NULL THEN
    IF v_existing.target_kind IS DISTINCT FROM 'group_application'
       OR v_existing.target_id IS DISTINCT FROM v_target_id
       OR v_existing.requested_revision IS NOT NULL
       OR v_existing.target_revision IS NOT NULL
    THEN
      RAISE EXCEPTION USING ERRCODE = '22023',
        MESSAGE = 'group media claim target conflict';
    END IF;
    RETURN v_result;
  END IF;

  PERFORM public.claim_post_media_manifest_internal(
    'group_submit', p_operation_id, p_actor_id, p_actor_id,
    'group_application', v_target_id, NULL, NULL, NULL, p_storage_origin,
    v_manifest,
    v_intent_fingerprint, v_result
  );
  RETURN v_result;
END
$function$;

CREATE OR REPLACE FUNCTION public.review_group_application_with_media_claims_atomic(
  p_reviewer_id uuid,
  p_application_id uuid,
  p_decision text,
  p_reject_reason text DEFAULT NULL,
  p_promo_unlocked boolean DEFAULT false,
  p_operation_id uuid DEFAULT NULL,
  p_storage_origin text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
SET lock_timeout = '5s'
SET statement_timeout = '15s'
AS $function$
DECLARE
  v_application_avatar_url text;
  v_application_owner_id uuid;
  v_avatar_object_name text;
  v_existing public.post_media_claim_sets%ROWTYPE;
  v_intent_fingerprint text;
  v_manifest text[] := ARRAY[]::text[];
  v_manifest_fingerprint text;
  v_result jsonb;
  v_target_id uuid;
  v_target_kind text;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'service role required';
  END IF;
  IF NOT pg_catalog.pg_try_advisory_xact_lock_shared(
    pg_catalog.hashtextextended('public-post-media-claims@1', 0)
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '55P03',
      MESSAGE = 'post media claims migration is active';
  END IF;
  IF p_operation_id IS NULL OR p_application_id IS NULL
     OR p_storage_origin IS NULL
     OR p_storage_origin IS DISTINCT FROM
       pg_catalog.lower(pg_catalog.btrim(p_storage_origin))
     OR pg_catalog.octet_length(p_storage_origin) NOT BETWEEN 8 AND 2048
     OR p_storage_origin ~ '[[:cntrl:]]'
     OR p_storage_origin ~ '[.][.]'
     OR p_storage_origin !~
       '^https?://(?:localhost|[a-z0-9](?:[a-z0-9-]{0,62})(?:[.][a-z0-9](?:[a-z0-9-]{0,62}))*)(?::[1-9][0-9]{0,4})?$'
  THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'group review media claim operation is required';
  END IF;
  v_intent_fingerprint := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_array(
      'review-group-with-media-claims:v1', p_reviewer_id, p_application_id,
      p_decision, p_reject_reason, p_promo_unlocked, p_storage_origin
    )::text, 'UTF8')), 'hex'
  );

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'post-media-claim-operation:group_review:'
        || pg_catalog.lower(p_operation_id::text), 0
    )
  );
  v_result := public.review_group_application_atomic(
    p_reviewer_id, p_application_id, p_decision, p_reject_reason,
    p_promo_unlocked, p_operation_id
  );
  IF v_result ->> 'status' NOT IN ('approved', 'rejected') THEN
    RETURN v_result;
  END IF;
  BEGIN
    IF (v_result ->> 'application_id')::uuid IS DISTINCT FROM p_application_id
    THEN
      RAISE EXCEPTION 'invalid';
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'group review media claim acknowledgement is invalid';
  END;

  SELECT claim_set.* INTO v_existing
  FROM public.post_media_claim_sets AS claim_set
  WHERE claim_set.scope = 'group_review'
    AND claim_set.operation_id = p_operation_id
  FOR SHARE;
  IF FOUND AND (
    v_existing.actor_id IS DISTINCT FROM p_reviewer_id
    OR v_existing.intent_fingerprint IS DISTINCT FROM v_intent_fingerprint
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'group review media claim operation conflict';
  END IF;

  SELECT application.applicant_id, application.avatar_url
  INTO v_application_owner_id, v_application_avatar_url
  FROM public.group_applications AS application
  WHERE application.id = p_application_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'reviewed group application is unavailable';
  END IF;

  SELECT COALESCE(
    pg_catalog.array_agg(
      upload_row.object_name ORDER BY upload_row.object_name COLLATE "C"
    ),
    ARRAY[]::text[]
  )
  INTO v_manifest
  FROM public.post_media_claims AS claim_row
  JOIN public.post_media_uploads AS upload_row
    ON upload_row.upload_id = claim_row.upload_id
  WHERE claim_row.target_kind = 'group_application'
    AND claim_row.target_id = p_application_id
    AND claim_row.reference_kind = 'group_avatar';

  -- Rolling compatibility: applications created before claim expansion can be
  -- attested from one exact canonical URL plus the durable private registry.
  IF pg_catalog.cardinality(v_manifest) = 0
     AND v_application_avatar_url IS NOT NULL
     AND pg_catalog.left(
       v_application_avatar_url,
       pg_catalog.length(
         p_storage_origin || '/storage/v1/object/public/posts/'
       )
     ) = p_storage_origin || '/storage/v1/object/public/posts/'
  THEN
    v_avatar_object_name := pg_catalog.substr(
      v_application_avatar_url,
      pg_catalog.length(
        p_storage_origin || '/storage/v1/object/public/posts/'
      ) + 1
    );
    IF v_avatar_object_name ~
      '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.](?:jpg|png|gif|webp|avif)$'
    THEN
      v_manifest := ARRAY[v_avatar_object_name];
    END IF;
  END IF;

  v_manifest_fingerprint := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_array(
      'post-media-claim-manifest:v1', v_manifest
    )::text, 'UTF8')), 'hex'
  );
  IF v_result ->> 'status' = 'approved' THEN
    v_target_kind := 'group';
    BEGIN
      v_target_id := (v_result ->> 'group_id')::uuid;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION USING ERRCODE = '55000',
        MESSAGE = 'approved group media claim acknowledgement is invalid';
    END;
  ELSE
    v_target_kind := 'group_application';
    v_target_id := p_application_id;
  END IF;

  IF v_existing.scope IS NOT NULL THEN
    IF v_existing.target_kind IS DISTINCT FROM v_target_kind
       OR v_existing.target_id IS DISTINCT FROM v_target_id
       OR v_existing.manifest_fingerprint IS DISTINCT FROM v_manifest_fingerprint
       OR v_existing.intent_fingerprint IS DISTINCT FROM v_intent_fingerprint
       OR v_existing.object_count IS DISTINCT FROM pg_catalog.cardinality(v_manifest)
    THEN
      RAISE EXCEPTION USING ERRCODE = '22023',
        MESSAGE = 'group review media claim operation conflict';
    END IF;
    RETURN v_result;
  END IF;

  PERFORM public.claim_post_media_manifest_internal(
    'group_review', p_operation_id, p_reviewer_id,
    v_application_owner_id, v_target_kind, v_target_id,
    CASE WHEN v_target_kind = 'group' THEN p_application_id END,
    NULL, NULL, p_storage_origin, v_manifest, v_intent_fingerprint, v_result
  );
  RETURN v_result;
END
$function$;

ALTER FUNCTION public.claim_post_media_manifest_internal(
  text, uuid, uuid, uuid, text, uuid, uuid, bigint, bigint, text, text[], text,
  jsonb
) OWNER TO postgres;
ALTER FUNCTION public.create_post_with_media_claims_atomic(
  uuid, uuid, text, text, uuid, text[], boolean, text[], text, integer,
  text, boolean, text, text, text[], text[], text[], text
) OWNER TO postgres;
ALTER FUNCTION public.edit_post_with_media_claims_atomic(
  uuid, uuid, bigint, text, text, boolean, text[], text, text[], text[],
  text[], uuid, text
) OWNER TO postgres;
ALTER FUNCTION public.submit_group_application_with_media_claims_atomic(
  uuid, text, text, text, text, text, jsonb, jsonb, text, boolean,
  boolean, uuid, text[], text
) OWNER TO postgres;
ALTER FUNCTION public.review_group_application_with_media_claims_atomic(
  uuid, uuid, text, text, boolean, uuid, text
) OWNER TO postgres;

DO $converge_function_acl$
DECLARE
  v_function regprocedure;
  v_grantee record;
  v_service_exposed boolean;
BEGIN
  FOR v_function, v_service_exposed IN
    SELECT expected.signature::pg_catalog.regprocedure,
      expected.service_exposed
    FROM (
      VALUES
        (
          'public.claim_post_media_manifest_internal(text,uuid,uuid,uuid,text,uuid,uuid,bigint,bigint,text,text[],text,jsonb)',
          false
        ),
        (
          'public.create_post_with_media_claims_atomic(uuid,uuid,text,text,uuid,text[],boolean,text[],text,integer,text,boolean,text,text,text[],text[],text[],text)',
          true
        ),
        (
          'public.edit_post_with_media_claims_atomic(uuid,uuid,bigint,text,text,boolean,text[],text,text[],text[],text[],uuid,text)',
          true
        ),
        (
          'public.submit_group_application_with_media_claims_atomic(uuid,text,text,text,text,text,jsonb,jsonb,text,boolean,boolean,uuid,text[],text)',
          true
        ),
        (
          'public.review_group_application_with_media_claims_atomic(uuid,uuid,text,text,boolean,uuid,text)',
          true
        )
    ) AS expected(signature, service_exposed)
  LOOP
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
        AND acl_entry.grantee <> function_row.proowner
    LOOP
      IF v_grantee.grantee = 0 THEN
        EXECUTE pg_catalog.format(
          'REVOKE ALL ON FUNCTION %s FROM PUBLIC CASCADE', v_function
        );
      ELSIF v_grantee.rolname IS NOT NULL THEN
        EXECUTE pg_catalog.format(
          'REVOKE ALL ON FUNCTION %s FROM %I CASCADE',
          v_function,
          v_grantee.rolname
        );
      END IF;
    END LOOP;
    IF v_service_exposed THEN
      EXECUTE pg_catalog.format(
        'GRANT EXECUTE ON FUNCTION %s TO service_role', v_function
      );
    END IF;
  END LOOP;
END
$converge_function_acl$;

DO $seal_functions$
DECLARE
  v_expected record;
  v_function regprocedure;
  v_source text;
BEGIN
  FOR v_expected IN
    SELECT *
    FROM (
      VALUES
        (
          'public.claim_post_media_manifest_internal(text,uuid,uuid,uuid,text,uuid,uuid,bigint,bigint,text,text[],text,jsonb)',
          'post-media-claims:internal-v1:',
          '16ce55b402e98e4decb1e044dcd2f881'
        ),
        (
          'public.create_post_with_media_claims_atomic(uuid,uuid,text,text,uuid,text[],boolean,text[],text,integer,text,boolean,text,text,text[],text[],text[],text)',
          'post-media-claims:create-v1:',
          '2982332579187d47e5d319e6699e9e91'
        ),
        (
          'public.edit_post_with_media_claims_atomic(uuid,uuid,bigint,text,text,boolean,text[],text,text[],text[],text[],uuid,text)',
          'post-media-claims:edit-v1:',
          '4ff2e5691dc27891442df50567a81c7d'
        ),
        (
          'public.submit_group_application_with_media_claims_atomic(uuid,text,text,text,text,text,jsonb,jsonb,text,boolean,boolean,uuid,text[],text)',
          'post-media-claims:group-submit-v1:',
          '3e46f03ddfa7bbd89e15b5d619109126'
        ),
        (
          'public.review_group_application_with_media_claims_atomic(uuid,uuid,text,text,boolean,uuid,text)',
          'post-media-claims:group-review-v1:',
          '0380908cb6c5ffca0ec86f683ebbbbe7'
        )
    ) AS expected(signature, prefix, source_digest)
  LOOP
    v_function := v_expected.signature::pg_catalog.regprocedure;
    SELECT function_row.prosrc INTO STRICT v_source
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_function;
    IF pg_catalog.md5(v_source) IS DISTINCT FROM v_expected.source_digest THEN
      RAISE EXCEPTION 'post media claim reviewed source digest drifted: %',
        v_function;
    END IF;
    EXECUTE pg_catalog.format(
      'COMMENT ON FUNCTION %s IS %L',
      v_function,
      v_expected.prefix || v_expected.source_digest
    );
  END LOOP;
END
$seal_functions$;

DO $postflight$
DECLARE
  v_relation regclass;
  v_function regprocedure;
  v_expected_service boolean;
BEGIN
  FOREACH v_relation IN ARRAY ARRAY[
    'public.post_media_uploads'::pg_catalog.regclass,
    'public.post_media_claim_sets'::pg_catalog.regclass,
    'public.post_media_claims'::pg_catalog.regclass
  ]
  LOOP
    IF EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS relation
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          relation.relacl,
          pg_catalog.acldefault('r', relation.relowner)
        )
      ) AS acl_entry
      WHERE relation.oid = v_relation
        AND acl_entry.grantee <> relation.relowner
    ) OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_attribute AS attribute
      CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl_entry
      WHERE attribute.attrelid = v_relation
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
        AND acl_entry.grantee <> pg_catalog.to_regrole('postgres')
    ) OR EXISTS (
      SELECT 1 FROM pg_catalog.pg_policy AS policy
      WHERE policy.polrelid = v_relation
    ) OR EXISTS (
      SELECT 1 FROM pg_catalog.pg_trigger AS trigger_row
      WHERE trigger_row.tgrelid = v_relation
        AND NOT trigger_row.tgisinternal
    ) THEN
      RAISE EXCEPTION 'post media claim privacy convergence failed: %',
        v_relation;
    END IF;
  END LOOP;

  IF (
    NOT pg_temp.post_media_claim_tables_are_exact()
    OR NOT pg_temp.post_media_claim_fk_triggers_are_safe(
      'public.post_media_claims'::regclass,
      'public.post_media_uploads'::regclass
    )
    OR NOT pg_temp.post_media_claim_publication_is_exact()
    OR NOT pg_temp.post_media_claim_role_graph_is_safe()
    OR NOT pg_temp.post_media_claim_authorities_are_safe()
    OR NOT pg_temp.post_media_upload_registry_is_exact()
    OR NOT pg_temp.post_media_upload_authorities_are_safe()
  )
  THEN
    RAISE EXCEPTION 'post media claim catalog or role graph postflight failed';
  END IF;

  FOR v_function, v_expected_service IN
    SELECT expected.signature::pg_catalog.regprocedure,
      expected.service_exposed
    FROM (
      VALUES
        (
          'public.claim_post_media_manifest_internal(text,uuid,uuid,uuid,text,uuid,uuid,bigint,bigint,text,text[],text,jsonb)', false
        ),
        (
          'public.create_post_with_media_claims_atomic(uuid,uuid,text,text,uuid,text[],boolean,text[],text,integer,text,boolean,text,text,text[],text[],text[],text)', true
        ),
        (
          'public.edit_post_with_media_claims_atomic(uuid,uuid,bigint,text,text,boolean,text[],text,text[],text[],text[],uuid,text)', true
        ),
        (
          'public.submit_group_application_with_media_claims_atomic(uuid,text,text,text,text,text,jsonb,jsonb,text,boolean,boolean,uuid,text[],text)', true
        ),
        (
          'public.review_group_application_with_media_claims_atomic(uuid,uuid,text,text,boolean,uuid,text)', true
        )
    ) AS expected(signature, service_exposed)
  LOOP
    IF (
      SELECT function_row.proowner = pg_catalog.to_regrole('postgres')
        AND function_row.prosecdef
        AND function_row.provolatile = 'v'
        AND function_row.proconfig @> ARRAY[
          'search_path=pg_catalog, pg_temp',
          'row_security=off',
          'lock_timeout=5s'
        ]::text[]
      FROM pg_catalog.pg_proc AS function_row
      WHERE function_row.oid = v_function
    ) IS NOT TRUE OR EXISTS (
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
          acl_entry.grantee <> pg_catalog.to_regrole('service_role')
          OR NOT v_expected_service
          OR acl_entry.privilege_type <> 'EXECUTE'
          OR acl_entry.is_grantable
        )
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
        AND acl_entry.grantee = pg_catalog.to_regrole('service_role')
        AND acl_entry.privilege_type = 'EXECUTE'
    ) IS DISTINCT FROM (
      CASE WHEN v_expected_service THEN 1::bigint ELSE 0::bigint END
    )
    THEN
      RAISE EXCEPTION 'post media claim function boundary drifted: %',
        v_function;
    END IF;
  END LOOP;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
