-- Migration: 20260803112000_post_media_coverage_inventory.sql
-- Created: 2026-08-03T11:20:00Z
-- Description: Add an inert, private, observe-only inventory for historical
--   post media coverage. The inventory records immutable evidence; it never
--   claims, releases, leases, admits, deletes, garbage-collects, or writes a
--   content, registry, claim, or Storage row. No application calls these names.
-- Phase: predeploy.
-- Classifier boundary: PostgreSQL deliberately implements only the reviewed
--   pg-lexical-v1 grammar. Anything that might normalize to the trusted origin
--   under WHATWG rules but is not lexically exact is quarantined as ambiguous.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';
SET LOCAL search_path = pg_catalog, public, pg_temp;
SET LOCAL standard_conforming_strings = on;

DO $migration_lock$
BEGIN
  -- Global order is immutable: claims, then coverage.
  IF NOT pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended('public-post-media-claims@1', 0)
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '55P03',
      MESSAGE = 'post media claims migration lock is busy';
  END IF;
  IF NOT pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended('public-post-media-coverage@1', 0)
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '55P03',
      MESSAGE = 'post media coverage migration lock is busy';
  END IF;
END
$migration_lock$;

CREATE OR REPLACE FUNCTION pg_temp.post_media_coverage_role_graph_is_safe()
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

CREATE OR REPLACE FUNCTION pg_temp.post_media_coverage_upload_dependency_is_exact()
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

CREATE OR REPLACE FUNCTION pg_temp.post_media_coverage_claim_dependencies_are_exact()
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

CREATE OR REPLACE FUNCTION pg_temp.post_media_coverage_claim_fk_triggers_are_safe(
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

-- Historical coverage treats the registry and claim rows as evidence only
-- after re-attesting the exact upstream mutation authorities that can create
-- those rows. These reviewed PostgreSQL 17 identities are inherited from the
-- 1100 registry and 1110 claim publications.
CREATE OR REPLACE FUNCTION pg_temp.post_media_claim_publication_is_exact()
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $function$
  WITH expected(
    signature,function_name,argument_names,argument_count,default_count,
    argument_definition_digest,source_digest,comment_prefix,service_exposed
  ) AS (
    VALUES
      (
        'public.claim_post_media_manifest_internal(text,uuid,uuid,uuid,text,uuid,uuid,bigint,bigint,text,text[],text,jsonb)',
        'claim_post_media_manifest_internal',
        ARRAY['p_scope','p_operation_id','p_actor_id','p_media_owner_id',
          'p_target_kind','p_target_id','p_source_application_id',
          'p_requested_revision','p_target_revision','p_storage_origin',
          'p_media_object_names','p_intent_fingerprint','p_result']::text[],
        13,0,'7f21301c3b69b016b72b1cd78d22bf56',
        '16ce55b402e98e4decb1e044dcd2f881','post-media-claims:internal-v1:',false
      ),
      (
        'public.create_post_with_media_claims_atomic(uuid,uuid,text,text,uuid,text[],boolean,text[],text,integer,text,boolean,text,text,text[],text[],text[],text)',
        'create_post_with_media_claims_atomic',
        ARRAY['p_actor_id','p_operation_id','p_title','p_content','p_group_id',
          'p_images','p_poll_enabled','p_poll_option_texts','p_poll_type',
          'p_poll_duration_hours','p_visibility','p_is_sensitive','p_content_warning',
          'p_language','p_mention_handles','p_hashtag_tags','p_media_object_names',
          'p_storage_origin']::text[],
        18,0,'7aa44283ca888dd7022c471ae0eded8f',
        '2982332579187d47e5d319e6699e9e91','post-media-claims:create-v1:',true
      ),
      (
        'public.edit_post_with_media_claims_atomic(uuid,uuid,bigint,text,text,boolean,text[],text,text[],text[],text[],uuid,text)',
        'edit_post_with_media_claims_atomic',
        ARRAY['p_actor_id','p_post_id','p_expected_version','p_title','p_content',
          'p_update_images','p_images','p_language','p_mention_handles','p_hashtag_tags',
          'p_media_object_names','p_operation_id','p_storage_origin']::text[],
        13,0,'f41e85cf8dc13d33c6fadd7a93c22aba',
        '4ff2e5691dc27891442df50567a81c7d','post-media-claims:edit-v1:',true
      ),
      (
        'public.submit_group_application_with_media_claims_atomic(uuid,text,text,text,text,text,jsonb,jsonb,text,boolean,boolean,uuid,text[],text)',
        'submit_group_application_with_media_claims_atomic',
        ARRAY['p_actor_id','p_name','p_name_en','p_description','p_description_en',
          'p_avatar_url','p_role_names','p_rules_json','p_rules','p_is_premium_only',
          'p_promo_unlocked','p_operation_id','p_media_object_names','p_storage_origin']::text[],
        14,12,'68e5695f2c2b87f7763b1e6c82a75c37',
        '3e46f03ddfa7bbd89e15b5d619109126','post-media-claims:group-submit-v1:',true
      ),
      (
        'public.review_group_application_with_media_claims_atomic(uuid,uuid,text,text,boolean,uuid,text)',
        'review_group_application_with_media_claims_atomic',
        ARRAY['p_reviewer_id','p_application_id','p_decision','p_reject_reason',
          'p_promo_unlocked','p_operation_id','p_storage_origin']::text[],
        7,4,'7f94fd69c3a26b14e14ebbd49ecda2dd',
        '0380908cb6c5ffca0ec86f683ebbbbe7','post-media-claims:group-review-v1:',true
      )
  ), resolved AS (
    SELECT expected.*,pg_catalog.to_regprocedure(expected.signature) AS function_oid
    FROM expected
  )
  SELECT NOT EXISTS (
    SELECT 1 FROM resolved AS expected
    LEFT JOIN pg_catalog.pg_proc AS function_row ON function_row.oid=expected.function_oid
    WHERE function_row.oid IS NULL
       OR function_row.pronamespace<>'public'::regnamespace
       OR function_row.proname<>expected.function_name
       OR function_row.prokind<>'f'
       OR function_row.proowner<>pg_catalog.to_regrole('postgres')
       OR NOT function_row.prosecdef OR function_row.provolatile<>'v'
       OR function_row.prolang<>(SELECT language_row.oid FROM pg_catalog.pg_language AS language_row
          WHERE language_row.lanname='plpgsql')
       OR function_row.prorettype<>'pg_catalog.jsonb'::regtype
       OR function_row.proretset OR function_row.proisstrict
       OR function_row.proparallel<>'u' OR function_row.proleakproof
       OR function_row.pronargs<>expected.argument_count
       OR function_row.pronargdefaults<>expected.default_count
       OR function_row.proargnames IS DISTINCT FROM expected.argument_names
       OR (expected.default_count=0 AND function_row.proargdefaults IS NOT NULL)
       OR (expected.default_count>0 AND function_row.proargdefaults IS NULL)
       OR pg_catalog.md5(pg_catalog.pg_get_function_arguments(function_row.oid))
            IS DISTINCT FROM expected.argument_definition_digest
       OR pg_catalog.md5(function_row.prosrc) IS DISTINCT FROM expected.source_digest
       OR function_row.provariadic<>0 OR function_row.proargmodes IS NOT NULL
       OR function_row.proallargtypes IS NOT NULL OR function_row.protrftypes IS NOT NULL
       OR function_row.prosupport<>0 OR function_row.prosqlbody IS NOT NULL
       OR function_row.probin IS NOT NULL OR function_row.procost<>100
       OR function_row.prorows<>0
       OR function_row.proconfig IS DISTINCT FROM ARRAY[
         'search_path=pg_catalog, pg_temp','row_security=off',
         'lock_timeout=5s','statement_timeout=15s']::text[]
       OR pg_catalog.obj_description(function_row.oid,'pg_proc')
            IS DISTINCT FROM expected.comment_prefix || expected.source_digest
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.pronamespace='public'::regnamespace
      AND function_row.proname IN ('claim_post_media_manifest_internal',
        'create_post_with_media_claims_atomic','edit_post_with_media_claims_atomic',
        'submit_group_application_with_media_claims_atomic',
        'review_group_application_with_media_claims_atomic')
      AND NOT EXISTS (SELECT 1 FROM resolved AS expected
        WHERE expected.function_oid=function_row.oid)
  ) AND NOT EXISTS (
    SELECT 1 FROM resolved AS expected
    JOIN pg_catalog.pg_proc AS function_row ON function_row.oid=expected.function_oid
    CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(
      function_row.proacl,pg_catalog.acldefault('f',function_row.proowner))) AS acl_entry
    WHERE acl_entry.grantee<>function_row.proowner
      AND (NOT expected.service_exposed
        OR acl_entry.grantee<>pg_catalog.to_regrole('service_role')
        OR acl_entry.privilege_type<>'EXECUTE' OR acl_entry.is_grantable)
  ) AND NOT EXISTS (
    SELECT 1 FROM resolved AS expected
    WHERE (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc AS function_row
      CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(
        function_row.proacl,pg_catalog.acldefault('f',function_row.proowner))) AS acl_entry
      WHERE function_row.oid=expected.function_oid
        AND acl_entry.grantee=pg_catalog.to_regrole('service_role')
        AND acl_entry.privilege_type='EXECUTE' AND NOT acl_entry.is_grantable)
      IS DISTINCT FROM CASE WHEN expected.service_exposed THEN 1::bigint ELSE 0::bigint END
  )
$function$;

CREATE OR REPLACE FUNCTION pg_temp.post_media_upload_authorities_are_safe()
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $function$
  WITH expected(signature,argument_names,argument_definition_digest,
    source_digest,comment_prefix) AS (
    VALUES
      ('public.reserve_post_media_upload_atomic(uuid,uuid,text,text,text,bigint)',
        ARRAY['p_upload_id','p_owner_id','p_object_name','p_purpose','p_mime_type','p_size_bytes']::text[],
        '1c403e56f319e2b97fff483724845fb8','56e6f09a800136a55e4249b2cf1ba9c4',
        'post-media-upload-registry:reserve-v1:'),
      ('public.finalize_post_media_upload_atomic(uuid,uuid,text,text,text,bigint)',
        ARRAY['p_upload_id','p_owner_id','p_object_name','p_purpose','p_mime_type','p_size_bytes']::text[],
        '1c403e56f319e2b97fff483724845fb8','4ff0dbce52d166d77321738991f75250',
        'post-media-upload-registry:finalize-v1:')
  ), resolved AS (
    SELECT expected.*,pg_catalog.to_regprocedure(expected.signature) AS function_oid
    FROM expected
  )
  SELECT NOT EXISTS (
    SELECT 1 FROM resolved AS expected
    LEFT JOIN pg_catalog.pg_proc AS function_row ON function_row.oid=expected.function_oid
    WHERE function_row.oid IS NULL OR function_row.prokind<>'f'
       OR function_row.proowner<>pg_catalog.to_regrole('postgres')
       OR NOT function_row.prosecdef OR function_row.provolatile<>'v'
       OR function_row.prolang<>(SELECT language_row.oid FROM pg_catalog.pg_language AS language_row
          WHERE language_row.lanname='plpgsql')
       OR function_row.prorettype<>'jsonb'::regtype
       OR function_row.proretset OR function_row.proisstrict
       OR function_row.proparallel<>'u' OR function_row.proleakproof
       OR function_row.pronargs<>6 OR function_row.pronargdefaults<>0
       OR function_row.proargdefaults IS NOT NULL
       OR function_row.proargnames IS DISTINCT FROM expected.argument_names
       OR pg_catalog.md5(pg_catalog.pg_get_function_arguments(function_row.oid))
            IS DISTINCT FROM expected.argument_definition_digest
       OR pg_catalog.md5(function_row.prosrc) IS DISTINCT FROM expected.source_digest
       OR function_row.provariadic<>0 OR function_row.proargmodes IS NOT NULL
       OR function_row.proallargtypes IS NOT NULL OR function_row.protrftypes IS NOT NULL
       OR function_row.prosupport<>0 OR function_row.prosqlbody IS NOT NULL
       OR function_row.probin IS NOT NULL OR function_row.procost<>100
       OR function_row.prorows<>0
       OR function_row.proconfig IS DISTINCT FROM ARRAY[
         'search_path=pg_catalog, pg_temp','row_security=off',
         'lock_timeout=5s','statement_timeout=15s']::text[]
       OR pg_catalog.obj_description(function_row.oid,'pg_proc')
            IS DISTINCT FROM expected.comment_prefix || expected.source_digest
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.pronamespace='public'::regnamespace
      AND function_row.proname IN ('reserve_post_media_upload_atomic',
        'finalize_post_media_upload_atomic')
      AND NOT EXISTS (SELECT 1 FROM resolved AS expected
        WHERE expected.function_oid=function_row.oid)
  ) AND NOT EXISTS (
    SELECT 1 FROM resolved AS expected
    JOIN pg_catalog.pg_proc AS function_row ON function_row.oid=expected.function_oid
    CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(
      function_row.proacl,pg_catalog.acldefault('f',function_row.proowner))) AS acl_entry
    WHERE acl_entry.grantee<>function_row.proowner
      AND (acl_entry.grantee<>pg_catalog.to_regrole('service_role')
        OR acl_entry.privilege_type<>'EXECUTE' OR acl_entry.is_grantable)
  ) AND NOT EXISTS (
    SELECT 1 FROM resolved AS expected WHERE expected.function_oid IS NOT NULL
      AND (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc AS function_row
        CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(
          function_row.proacl,pg_catalog.acldefault('f',function_row.proowner))) AS acl_entry
        WHERE function_row.oid=expected.function_oid
          AND acl_entry.grantee=pg_catalog.to_regrole('service_role')
          AND acl_entry.privilege_type='EXECUTE' AND NOT acl_entry.is_grantable)<>1
  )
$function$;

CREATE OR REPLACE FUNCTION pg_temp.post_media_coverage_foundations_are_exact()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  v_relation regclass;
BEGIN
  IF NOT pg_temp.post_media_coverage_upload_dependency_is_exact()
     OR NOT pg_temp.post_media_coverage_claim_dependencies_are_exact()
     OR NOT pg_temp.post_media_upload_authorities_are_safe()
     OR NOT pg_temp.post_media_claim_publication_is_exact()
     OR NOT pg_temp.post_media_coverage_claim_fk_triggers_are_safe(
       'public.post_media_claims'::regclass,
       'public.post_media_uploads'::regclass
     )
  THEN
    RETURN false;
  END IF;

  FOREACH v_relation IN ARRAY ARRAY[
    'public.post_media_claim_sets'::regclass,
    'public.post_media_claims'::regclass
  ]
  LOOP
    IF NOT (
      SELECT relation.relowner=pg_catalog.to_regrole('postgres')
        AND relation.relkind='r' AND relation.relpersistence='p'
        AND NOT relation.relispartition
        AND relation.relrowsecurity AND relation.relforcerowsecurity
        AND relation.relreplident='d' AND relation.reloptions IS NULL
      FROM pg_catalog.pg_class AS relation WHERE relation.oid=v_relation
    ) OR EXISTS (
      SELECT 1 FROM pg_catalog.pg_policy AS policy WHERE policy.polrelid=v_relation
    ) OR EXISTS (
      SELECT 1 FROM pg_catalog.pg_trigger AS trigger_row
      WHERE trigger_row.tgrelid=v_relation AND NOT trigger_row.tgisinternal
    ) OR EXISTS (
      SELECT 1 FROM pg_catalog.pg_inherits AS inheritance
      WHERE inheritance.inhrelid=v_relation OR inheritance.inhparent=v_relation
    ) OR EXISTS (
      SELECT 1 FROM pg_catalog.pg_rewrite AS rewrite_rule
      WHERE rewrite_rule.ev_class=v_relation AND rewrite_rule.rulename<>'_RETURN'
    ) OR EXISTS (
      SELECT 1 FROM pg_catalog.pg_class AS relation
      CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(
        relation.relacl,pg_catalog.acldefault('r',relation.relowner)
      )) AS acl_entry
      WHERE relation.oid=v_relation AND acl_entry.grantee<>relation.relowner
    ) OR EXISTS (
      SELECT 1 FROM pg_catalog.pg_attribute AS attribute
      CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl_entry
      WHERE attribute.attrelid=v_relation AND attribute.attnum>0
        AND NOT attribute.attisdropped
        AND acl_entry.grantee<>pg_catalog.to_regrole('postgres')
    ) THEN
      RETURN false;
    END IF;
  END LOOP;

  FOREACH v_relation IN ARRAY ARRAY[
    'public.posts'::regclass,
    'public.group_applications'::regclass,
    'public.groups'::regclass
  ]
  LOOP
    IF NOT (
      SELECT relation.relowner=pg_catalog.to_regrole('postgres')
        AND relation.relkind='r' AND relation.relpersistence='p'
        AND NOT relation.relispartition
        AND relation.relreplident='d' AND relation.reloptions IS NULL
        AND relation.relam=(SELECT access_method.oid FROM pg_catalog.pg_am AS access_method
          WHERE access_method.amname='heap' AND access_method.amtype='t')
      FROM pg_catalog.pg_class AS relation WHERE relation.oid=v_relation
    ) OR EXISTS (
      SELECT 1 FROM pg_catalog.pg_inherits AS inheritance
      WHERE inheritance.inhrelid=v_relation OR inheritance.inhparent=v_relation
    ) OR EXISTS (
      SELECT 1 FROM pg_catalog.pg_rewrite AS rewrite_rule
      WHERE rewrite_rule.ev_class=v_relation AND rewrite_rule.rulename<>'_RETURN'
    ) OR NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_index AS index_row
      JOIN pg_catalog.pg_class AS index_relation
        ON index_relation.oid=index_row.indexrelid
      JOIN pg_catalog.pg_am AS access_method ON access_method.oid=index_relation.relam
      WHERE index_row.indrelid=v_relation
        AND index_row.indisunique AND index_row.indisprimary
        AND index_row.indisvalid AND index_row.indisready AND index_row.indislive
        AND index_row.indimmediate AND NOT index_row.indisexclusion
        AND NOT index_row.indisclustered AND NOT index_row.indisreplident
        AND NOT index_row.indnullsnotdistinct
        AND index_row.indpred IS NULL AND index_row.indexprs IS NULL
        AND index_row.indnkeyatts=1 AND index_row.indnatts=1
        AND access_method.amname='btree'
        AND index_relation.relkind='i' AND index_relation.relpersistence='p'
        AND index_relation.relowner=pg_catalog.to_regrole('postgres')
        AND index_row.indclass[0]=(SELECT operator_class.oid
          FROM pg_catalog.pg_opclass AS operator_class
          JOIN pg_catalog.pg_am AS class_method ON class_method.oid=operator_class.opcmethod
          WHERE class_method.amname='btree' AND operator_class.opcname='uuid_ops'
            AND operator_class.opcintype='uuid'::regtype)
        AND index_row.indcollation[0]=0 AND index_row.indoption[0]=0
        AND index_row.indkey[0]=(
          SELECT attribute.attnum FROM pg_catalog.pg_attribute AS attribute
          WHERE attribute.attrelid=v_relation AND attribute.attname='id'
            AND attribute.attnum>0 AND NOT attribute.attisdropped
        )
    ) THEN
      RETURN false;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1 FROM (VALUES
      ('posts','id','uuid'::regtype,true),('posts','author_id','uuid'::regtype,false),
      ('posts','content','text'::regtype,false),('posts','images','text[]'::regtype,false),
      ('posts','content_version','bigint'::regtype,true),
      ('posts','deleted_at','timestamptz'::regtype,false),
      ('posts','status','public.post_status'::regtype,true),
      ('group_applications','id','uuid'::regtype,true),
      ('group_applications','applicant_id','uuid'::regtype,true),
      ('group_applications','avatar_url','text'::regtype,false),
      ('group_applications','status','text'::regtype,true),
      ('group_applications','group_id','uuid'::regtype,false),
      ('groups','id','uuid'::regtype,true),('groups','created_by','uuid'::regtype,true),
      ('groups','avatar_url','text'::regtype,false)
    ) AS expected(table_name,column_name,type_oid,not_null)
    LEFT JOIN pg_catalog.pg_attribute AS attribute
      ON attribute.attrelid=pg_catalog.to_regclass('public.' || expected.table_name)
     AND attribute.attname=expected.column_name AND attribute.attnum>0
     AND NOT attribute.attisdropped
    WHERE attribute.attname IS NULL OR attribute.atttypid<>expected.type_oid
       OR attribute.attnotnull IS DISTINCT FROM expected.not_null
       OR attribute.atttypmod<>-1 OR attribute.attidentity<>''
       OR attribute.attgenerated<>''
       OR attribute.attcollation IS DISTINCT FROM (
         SELECT type_row.typcollation FROM pg_catalog.pg_type AS type_row
         WHERE type_row.oid=expected.type_oid
       )
       OR attribute.attndims<>CASE WHEN expected.type_oid='text[]'::regtype THEN 1 ELSE 0 END
       OR attribute.attinhcount<>0 OR NOT attribute.attislocal
       OR attribute.atthasmissing OR attribute.attoptions IS NOT NULL
       OR attribute.attfdwoptions IS NOT NULL
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_type AS type_row
    JOIN pg_catalog.pg_enum AS enum_row ON enum_row.enumtypid=type_row.oid
    WHERE type_row.oid='public.post_status'::regtype AND enum_row.enumlabel='active'
  ) THEN
    RETURN false;
  END IF;

  RETURN (
    SELECT relation.relkind='r' AND relation.relpersistence='p'
      AND NOT relation.relispartition AND relation.relreplident='d'
      AND relation.relam=(SELECT access_method.oid FROM pg_catalog.pg_am AS access_method
        WHERE access_method.amname='heap' AND access_method.amtype='t')
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid='storage.objects'::regclass
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_inherits AS inheritance
    WHERE inheritance.inhrelid='storage.objects'::regclass
       OR inheritance.inhparent='storage.objects'::regclass
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_rewrite AS rewrite_rule
    WHERE rewrite_rule.ev_class='storage.objects'::regclass
      AND rewrite_rule.rulename<>'_RETURN'
  ) AND EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index AS index_row
    JOIN pg_catalog.pg_class AS index_relation ON index_relation.oid=index_row.indexrelid
    JOIN pg_catalog.pg_am AS access_method ON access_method.oid=index_relation.relam
    WHERE index_row.indrelid='storage.objects'::regclass
      AND index_row.indisunique AND index_row.indisvalid
      AND index_row.indisready AND index_row.indislive AND index_row.indimmediate
      AND NOT index_row.indisexclusion AND NOT index_row.indisclustered
      AND NOT index_row.indisreplident AND NOT index_row.indnullsnotdistinct
      AND index_row.indpred IS NULL AND index_row.indexprs IS NULL
      AND index_row.indnkeyatts=2 AND index_row.indnatts=2
      AND access_method.amname='btree'
      AND index_relation.relkind='i' AND index_relation.relpersistence='p'
      AND index_relation.relowner=(SELECT relation.relowner FROM pg_catalog.pg_class AS relation
        WHERE relation.oid='storage.objects'::regclass)
      AND index_row.indclass[0]=(SELECT operator_class.oid
        FROM pg_catalog.pg_opclass AS operator_class
        JOIN pg_catalog.pg_am AS class_method ON class_method.oid=operator_class.opcmethod
        WHERE class_method.amname='btree' AND operator_class.opcname='text_ops'
          AND operator_class.opcintype='text'::regtype)
      AND index_row.indclass[1]=index_row.indclass[0]
      AND index_row.indcollation[0]='pg_catalog."default"'::regcollation
      AND index_row.indcollation[1]='pg_catalog."default"'::regcollation
      AND index_row.indoption[0]=0 AND index_row.indoption[1]=0
      AND (SELECT pg_catalog.array_agg(attribute.attname ORDER BY key.ordinality)
        FROM pg_catalog.unnest(index_row.indkey)
          WITH ORDINALITY AS key(attnum,ordinality)
        JOIN pg_catalog.pg_attribute AS attribute
          ON attribute.attrelid=index_row.indrelid AND attribute.attnum=key.attnum
      )=ARRAY['bucket_id','name']::name[]
  ) AND NOT EXISTS (
    SELECT 1 FROM (VALUES
      ('bucket_id','text'::regtype,false),('name','text'::regtype,false)
    ) AS expected(column_name,type_oid,not_null)
    LEFT JOIN pg_catalog.pg_attribute AS attribute
      ON attribute.attrelid='storage.objects'::regclass
     AND attribute.attname=expected.column_name AND attribute.attnum>0
     AND NOT attribute.attisdropped
    WHERE attribute.attname IS NULL OR attribute.atttypid<>expected.type_oid
       OR attribute.attnotnull IS DISTINCT FROM expected.not_null
       OR attribute.atttypmod<>-1 OR attribute.attidentity<>''
       OR attribute.attgenerated<>'' OR attribute.attndims<>0
       OR attribute.attcollation<>'pg_catalog."default"'::regcollation
       OR attribute.attinhcount<>0 OR NOT attribute.attislocal
       OR attribute.atthasmissing OR attribute.attoptions IS NOT NULL
       OR attribute.attfdwoptions IS NOT NULL
  );
END
$function$;

CREATE OR REPLACE FUNCTION pg_temp.post_media_coverage_tables_are_exact()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  v_relation regclass;
  v_expected_count integer;
BEGIN
  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_class AS relation
    WHERE relation.relnamespace='public'::regnamespace
      AND relation.relname LIKE 'post\_media\_coverage\_%' ESCAPE '\'
      AND relation.relkind NOT IN ('i','I')
  ) <> 5 THEN
    RETURN false;
  END IF;
  FOREACH v_relation IN ARRAY ARRAY[
    'public.post_media_coverage_config'::regclass,
    'public.post_media_coverage_runs'::regclass,
    'public.post_media_coverage_targets'::regclass,
    'public.post_media_coverage_attempts'::regclass,
    'public.post_media_coverage_references'::regclass
  ]
  LOOP
    IF NOT (
      SELECT relation.relkind = 'r'
        AND relation.relpersistence = 'p'
        AND NOT relation.relispartition
        AND relation.relam = (
          SELECT access_method.oid FROM pg_catalog.pg_am AS access_method
          WHERE access_method.amname = 'heap'
        )
        AND relation.relowner = pg_catalog.to_regrole('postgres')
        AND relation.relrowsecurity
        AND relation.relforcerowsecurity
        AND relation.relreplident = 'd'
        AND relation.reloptions IS NULL
      FROM pg_catalog.pg_class AS relation
      WHERE relation.oid = v_relation
    ) OR EXISTS (
      SELECT 1 FROM pg_catalog.pg_inherits AS inheritance
      WHERE inheritance.inhrelid = v_relation OR inheritance.inhparent = v_relation
    ) OR EXISTS (
      SELECT 1 FROM pg_catalog.pg_rewrite AS rewrite_rule
      WHERE rewrite_rule.ev_class = v_relation AND rewrite_rule.rulename <> '_RETURN'
    ) OR EXISTS (
      SELECT 1 FROM pg_catalog.pg_trigger AS trigger_row
      WHERE trigger_row.tgrelid = v_relation AND NOT trigger_row.tgisinternal
    ) OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS relation
      CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(
        relation.relacl, pg_catalog.acldefault('r', relation.relowner)
      )) AS acl_entry
      WHERE relation.oid = v_relation AND acl_entry.grantee <> relation.relowner
    ) OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_attribute AS attribute
      CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl_entry
      WHERE attribute.attrelid = v_relation
        AND attribute.attnum > 0 AND NOT attribute.attisdropped
        AND acl_entry.grantee <> pg_catalog.to_regrole('postgres')
    ) OR EXISTS (
      SELECT 1 FROM pg_catalog.pg_policy AS policy WHERE policy.polrelid = v_relation
    ) THEN
      RETURN false;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('post_media_coverage_config', 1, 'config_id', 'smallint'::regtype, true),
        ('post_media_coverage_config', 2, 'revision', 'bigint'::regtype, true),
        ('post_media_coverage_config', 3, 'storage_origin', 'text'::regtype, true),
        ('post_media_coverage_config', 4, 'origin_fingerprint', 'text'::regtype, true),
        ('post_media_coverage_config', 5, 'classifier_version', 'text'::regtype, true),
        ('post_media_coverage_config', 6, 'installed_at', 'timestamptz'::regtype, true),
        ('post_media_coverage_runs', 1, 'run_id', 'uuid'::regtype, true),
        ('post_media_coverage_runs', 2, 'operation_id', 'uuid'::regtype, true),
        ('post_media_coverage_runs', 3, 'generation', 'bigint'::regtype, true),
        ('post_media_coverage_runs', 4, 'config_revision', 'bigint'::regtype, true),
        ('post_media_coverage_runs', 5, 'storage_origin', 'text'::regtype, true),
        ('post_media_coverage_runs', 6, 'origin_fingerprint', 'text'::regtype, true),
        ('post_media_coverage_runs', 7, 'classifier_version', 'text'::regtype, true),
        ('post_media_coverage_runs', 8, 'state', 'text'::regtype, true),
        ('post_media_coverage_runs', 9, 'cursor_kind', 'text'::regtype, true),
        ('post_media_coverage_runs', 10, 'cursor_id', 'uuid'::regtype, true),
        ('post_media_coverage_runs', 11, 'started_at', 'timestamptz'::regtype, true),
        ('post_media_coverage_runs', 12, 'reconciling_at', 'timestamptz'::regtype, false),
        ('post_media_coverage_runs', 13, 'sealed_at', 'timestamptz'::regtype, false),
        ('post_media_coverage_runs', 14, 'population_fingerprint', 'text'::regtype, false),
        ('post_media_coverage_runs', 15, 'target_count', 'integer'::regtype, true),
        ('post_media_coverage_runs', 16, 'observed_count', 'integer'::regtype, true),
        ('post_media_coverage_runs', 17, 'post_edit_count', 'integer'::regtype, true),
        ('post_media_coverage_runs', 18, 'group_review_count', 'integer'::regtype, true),
        ('post_media_coverage_runs', 19, 'group_avatar_count', 'integer'::regtype, true),
        ('post_media_coverage_runs', 20, 'audit_only_count', 'integer'::regtype, true),
        ('post_media_coverage_runs', 21, 'empty_count', 'integer'::regtype, true),
        ('post_media_coverage_runs', 22, 'external_only_count', 'integer'::regtype, true),
        ('post_media_coverage_runs', 23, 'covered_count', 'integer'::regtype, true),
        ('post_media_coverage_runs', 24, 'quarantined_count', 'integer'::regtype, true),
        ('post_media_coverage_runs', 25, 'source_absent_count', 'integer'::regtype, true),
        ('post_media_coverage_runs', 26, 'claimable_count', 'integer'::regtype, true),
        ('post_media_coverage_runs', 27, 'conflicting_count', 'integer'::regtype, true),
        ('post_media_coverage_runs', 28, 'cursor_started', 'boolean'::regtype, true),
        ('post_media_coverage_targets', 1, 'run_id', 'uuid'::regtype, true),
        ('post_media_coverage_targets', 2, 'target_kind', 'text'::regtype, true),
        ('post_media_coverage_targets', 3, 'target_id', 'uuid'::regtype, true),
        ('post_media_coverage_targets', 4, 'attempt', 'integer'::regtype, true),
        ('post_media_coverage_targets', 5, 'queue_state', 'text'::regtype, true),
        ('post_media_coverage_targets', 6, 'source_owner_id', 'uuid'::regtype, false),
        ('post_media_coverage_targets', 7, 'source_revision', 'bigint'::regtype, false),
        ('post_media_coverage_targets', 8, 'source_status', 'text'::regtype, false),
        ('post_media_coverage_targets', 9, 'source_group_id', 'uuid'::regtype, false),
        ('post_media_coverage_targets', 10, 'source_fingerprint', 'text'::regtype, true),
        ('post_media_coverage_targets', 11, 'link_fingerprint', 'text'::regtype, true),
        ('post_media_coverage_targets', 12, 'eligibility', 'text'::regtype, true),
        ('post_media_coverage_targets', 13, 'coverage_state', 'text'::regtype, false),
        ('post_media_coverage_targets', 14, 'claim_state', 'text'::regtype, false),
        ('post_media_coverage_targets', 15, 'manifest_fingerprint', 'text'::regtype, false),
        ('post_media_coverage_targets', 16, 'reference_count', 'integer'::regtype, true),
        ('post_media_coverage_targets', 17, 'managed_count', 'integer'::regtype, true),
        ('post_media_coverage_targets', 18, 'external_count', 'integer'::regtype, true),
        ('post_media_coverage_targets', 19, 'blockers', 'text[]'::regtype, true),
        ('post_media_coverage_targets', 20, 'enqueued_at', 'timestamptz'::regtype, true),
        ('post_media_coverage_targets', 21, 'observed_at', 'timestamptz'::regtype, false),
        ('post_media_coverage_attempts', 1, 'run_id', 'uuid'::regtype, true),
        ('post_media_coverage_attempts', 2, 'target_kind', 'text'::regtype, true),
        ('post_media_coverage_attempts', 3, 'target_id', 'uuid'::regtype, true),
        ('post_media_coverage_attempts', 4, 'attempt', 'integer'::regtype, true),
        ('post_media_coverage_attempts', 5, 'source_owner_id', 'uuid'::regtype, false),
        ('post_media_coverage_attempts', 6, 'source_revision', 'bigint'::regtype, false),
        ('post_media_coverage_attempts', 7, 'source_status', 'text'::regtype, false),
        ('post_media_coverage_attempts', 8, 'source_group_id', 'uuid'::regtype, false),
        ('post_media_coverage_attempts', 9, 'source_fingerprint', 'text'::regtype, true),
        ('post_media_coverage_attempts', 10, 'link_fingerprint', 'text'::regtype, true),
        ('post_media_coverage_attempts', 11, 'eligibility', 'text'::regtype, true),
        ('post_media_coverage_attempts', 12, 'coverage_state', 'text'::regtype, false),
        ('post_media_coverage_attempts', 13, 'claim_state', 'text'::regtype, false),
        ('post_media_coverage_attempts', 14, 'manifest_fingerprint', 'text'::regtype, false),
        ('post_media_coverage_attempts', 15, 'reference_count', 'integer'::regtype, true),
        ('post_media_coverage_attempts', 16, 'managed_count', 'integer'::regtype, true),
        ('post_media_coverage_attempts', 17, 'external_count', 'integer'::regtype, true),
        ('post_media_coverage_attempts', 18, 'blockers', 'text[]'::regtype, true),
        ('post_media_coverage_attempts', 19, 'observed_at', 'timestamptz'::regtype, false),
        ('post_media_coverage_references', 1, 'run_id', 'uuid'::regtype, true),
        ('post_media_coverage_references', 2, 'target_kind', 'text'::regtype, true),
        ('post_media_coverage_references', 3, 'target_id', 'uuid'::regtype, true),
        ('post_media_coverage_references', 4, 'attempt', 'integer'::regtype, true),
        ('post_media_coverage_references', 5, 'reference_key', 'text'::regtype, true),
        ('post_media_coverage_references', 6, 'source_mask', 'integer'::regtype, true),
        ('post_media_coverage_references', 7, 'occurrences', 'integer'::regtype, true),
        ('post_media_coverage_references', 8, 'raw_sha256', 'text'::regtype, true),
        ('post_media_coverage_references', 9, 'raw_length', 'integer'::regtype, true),
        ('post_media_coverage_references', 10, 'classification', 'text'::regtype, true),
        ('post_media_coverage_references', 11, 'expected_reference_kind', 'text'::regtype, true),
        ('post_media_coverage_references', 12, 'object_name', 'text'::regtype, false),
        ('post_media_coverage_references', 13, 'upload_id', 'uuid'::regtype, false),
        ('post_media_coverage_references', 14, 'registry_state', 'text'::regtype, true),
        ('post_media_coverage_references', 15, 'storage_state', 'text'::regtype, true),
        ('post_media_coverage_references', 16, 'claim_state', 'text'::regtype, true),
        ('post_media_coverage_references', 17, 'finding', 'text'::regtype, true),
        ('post_media_coverage_references', 18, 'observed_at', 'timestamptz'::regtype, true)
    ) AS expected(table_name, ordinal, column_name, type_oid, not_null)
    LEFT JOIN pg_catalog.pg_attribute AS attribute
      ON attribute.attrelid = pg_catalog.to_regclass('public.' || expected.table_name)
     AND attribute.attnum = expected.ordinal
     AND attribute.attname = expected.column_name
     AND NOT attribute.attisdropped
    WHERE attribute.attname IS NULL
       OR attribute.atttypid <> expected.type_oid
       OR attribute.attnotnull IS DISTINCT FROM expected.not_null
       OR attribute.atttypmod <> -1
       OR attribute.attidentity <> ''
       OR attribute.attgenerated <> ''
       OR attribute.attcollation IS DISTINCT FROM (
         SELECT type_row.typcollation FROM pg_catalog.pg_type AS type_row
         WHERE type_row.oid=expected.type_oid
       )
       OR attribute.attstorage IS DISTINCT FROM (
         SELECT type_row.typstorage FROM pg_catalog.pg_type AS type_row
         WHERE type_row.oid=expected.type_oid
       )
       OR attribute.attcompression <> ''
       OR attribute.attndims <> CASE WHEN expected.type_oid='text[]'::regtype THEN 1 ELSE 0 END
       OR attribute.attstattarget <> -1
       OR attribute.attinhcount <> 0
       OR NOT attribute.attislocal
       OR attribute.atthasmissing
       OR attribute.attoptions IS NOT NULL
       OR attribute.attfdwoptions IS NOT NULL
  ) THEN
    RETURN false;
  END IF;

  FOREACH v_relation IN ARRAY ARRAY[
    'public.post_media_coverage_config'::regclass,
    'public.post_media_coverage_runs'::regclass,
    'public.post_media_coverage_targets'::regclass,
    'public.post_media_coverage_attempts'::regclass,
    'public.post_media_coverage_references'::regclass
  ]
  LOOP
    v_expected_count := CASE v_relation::text
      WHEN 'post_media_coverage_config' THEN 6
      WHEN 'post_media_coverage_runs' THEN 28
      WHEN 'post_media_coverage_targets' THEN 21
      WHEN 'post_media_coverage_attempts' THEN 19
      ELSE 18
    END;
    IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid = v_relation AND attribute.attnum > 0
          AND NOT attribute.attisdropped) <> v_expected_count
       OR EXISTS (SELECT 1 FROM pg_catalog.pg_attribute AS attribute
          WHERE attribute.attrelid = v_relation AND attribute.attnum > 0
            AND attribute.attisdropped)
    THEN
      RETURN false;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_attrdef AS default_row
    WHERE default_row.adrelid IN (
      'public.post_media_coverage_config'::regclass,
      'public.post_media_coverage_runs'::regclass,
      'public.post_media_coverage_targets'::regclass,
      'public.post_media_coverage_attempts'::regclass,
      'public.post_media_coverage_references'::regclass
    )
  ) OR (
    SELECT pg_catalog.count(*) FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid IN (
      'public.post_media_coverage_config'::regclass,
      'public.post_media_coverage_runs'::regclass,
      'public.post_media_coverage_targets'::regclass,
      'public.post_media_coverage_attempts'::regclass,
      'public.post_media_coverage_references'::regclass
    )
  ) <> 23 OR EXISTS (
    SELECT 1
    FROM (VALUES
      ('post_media_coverage_config','post_media_coverage_config_pkey','p','e2ca174b295ab13d369d7bcb2ad8b69c',ARRAY[1]::smallint[],NULL::text,NULL::smallint[]),
      ('post_media_coverage_config','post_media_coverage_config_singleton_check','c','380423311a2659c823d4f97a2f8f6a91',ARRAY[1]::smallint[],NULL::text,NULL::smallint[]),
      ('post_media_coverage_config','post_media_coverage_config_revision_check','c','a66923351928a9d48563855a9dd023bd',ARRAY[2]::smallint[],NULL::text,NULL::smallint[]),
      ('post_media_coverage_config','post_media_coverage_config_origin_check','c','17b17738cbdf6dfe7c66cf53dc97e672',ARRAY[3,4,5,6]::smallint[],NULL::text,NULL::smallint[]),
      ('post_media_coverage_runs','post_media_coverage_runs_pkey','p','a8b731547aea2eae42ff76e39e79843b',ARRAY[1]::smallint[],NULL::text,NULL::smallint[]),
      ('post_media_coverage_runs','post_media_coverage_runs_operation_key','u','f043100fab0c9b03e53e7b0821a89baa',ARRAY[2]::smallint[],NULL::text,NULL::smallint[]),
      ('post_media_coverage_runs','post_media_coverage_runs_generation_key','u','d0d5209e2245cef902a747052d499ce3',ARRAY[3]::smallint[],NULL::text,NULL::smallint[]),
      ('post_media_coverage_runs','post_media_coverage_runs_snapshot_check','c','b097f29f53b189c95bd4829f7a7a7b98',ARRAY[3,4,6,7]::smallint[],NULL::text,NULL::smallint[]),
      ('post_media_coverage_runs','post_media_coverage_runs_state_check','c','b926bd26cc9fcd9ac94d7029eb5ec20a',ARRAY[8,9,28,10,12,13,14]::smallint[],NULL::text,NULL::smallint[]),
      ('post_media_coverage_runs','post_media_coverage_runs_time_check','c','f8cda3f56f083bf341145fd085f916bb',ARRAY[11,12,13]::smallint[],NULL::text,NULL::smallint[]),
      ('post_media_coverage_runs','post_media_coverage_runs_count_check','c','bf3c7084770923ce7da1a85b17a29c75',ARRAY[15,16,17,18,19,20,21,22,23,24,25,26,27]::smallint[],NULL::text,NULL::smallint[]),
      ('post_media_coverage_targets','post_media_coverage_targets_pkey','p','6de21b7d0413a312020678f87aac9b84',ARRAY[1,2,3]::smallint[],NULL::text,NULL::smallint[]),
      ('post_media_coverage_targets','post_media_coverage_targets_run_fkey','f','0be128e1c505434f807e26fd2ebd5fc1',ARRAY[1]::smallint[],'post_media_coverage_runs',ARRAY[1]::smallint[]),
      ('post_media_coverage_targets','post_media_coverage_targets_kind_check','c','803436dc4bcd53711f087eb1f474d138',ARRAY[2]::smallint[],NULL::text,NULL::smallint[]),
      ('post_media_coverage_targets','post_media_coverage_targets_queue_check','c','bc9bdf74847bd51062f0b3a74db36f81',ARRAY[4,5]::smallint[],NULL::text,NULL::smallint[]),
      ('post_media_coverage_targets','post_media_coverage_targets_evidence_check','c','9c47327a1ac7ff7ca3bb49792dd02869',ARRAY[10,11,12,16,17,18,19,20,5,13,14,15,21]::smallint[],NULL::text,NULL::smallint[]),
      ('post_media_coverage_attempts','post_media_coverage_attempts_pkey','p','909b1e3060fa24ed1d3aee87e6296bfd',ARRAY[1,2,3,4]::smallint[],NULL::text,NULL::smallint[]),
      ('post_media_coverage_attempts','post_media_coverage_attempts_target_fkey','f','45a4418318daf8a07216a45ce505b923',ARRAY[1,2,3]::smallint[],'post_media_coverage_targets',ARRAY[1,2,3]::smallint[]),
      ('post_media_coverage_attempts','post_media_coverage_attempts_evidence_check','c','7905abbd22f404df0093b4eb4efa55bd',ARRAY[2,4,9,10,11,15,16,17,18,19,12,13,14]::smallint[],NULL::text,NULL::smallint[]),
      ('post_media_coverage_references','post_media_coverage_references_pkey','p','2aee9cc627cbd0c00cc6d9b151d39869',ARRAY[1,2,3,4,5]::smallint[],NULL::text,NULL::smallint[]),
      ('post_media_coverage_references','post_media_coverage_references_attempt_fkey','f','c62be01560885ca90020058797d99195',ARRAY[1,2,3,4]::smallint[],'post_media_coverage_attempts',ARRAY[1,2,3,4]::smallint[]),
      ('post_media_coverage_references','post_media_coverage_references_identity_check','c','6510bb726d6e061effaff2ef3e2e47b8',ARRAY[2,4,5,8,9,6,7]::smallint[],NULL::text,NULL::smallint[]),
      ('post_media_coverage_references','post_media_coverage_references_classification_check','c','c8d66d4f6620463c71e6deb764debec3',ARRAY[10,11,14,15,16,17,18,12,13]::smallint[],NULL::text,NULL::smallint[])
    ) AS expected(table_name,constraint_name,constraint_type,definition_digest,conkey,conf_table_name,confkey)
    LEFT JOIN pg_catalog.pg_constraint AS constraint_row
      ON constraint_row.conrelid=pg_catalog.to_regclass('public.' || expected.table_name)
     AND constraint_row.conname=expected.constraint_name
     AND constraint_row.contype=expected.constraint_type::"char"
    WHERE constraint_row.oid IS NULL
       OR NOT constraint_row.convalidated
       OR constraint_row.condeferrable
       OR constraint_row.condeferred
       OR NOT constraint_row.conislocal
       OR constraint_row.coninhcount<>0
       OR constraint_row.conparentid<>0
       OR constraint_row.connoinherit IS DISTINCT FROM (expected.constraint_type<>'c')
       OR constraint_row.conkey IS DISTINCT FROM expected.conkey
       OR constraint_row.confrelid IS DISTINCT FROM CASE
            WHEN expected.conf_table_name IS NULL THEN 0::oid
            ELSE pg_catalog.to_regclass('public.' || expected.conf_table_name)::oid END
       OR constraint_row.confkey IS DISTINCT FROM expected.confkey
       OR pg_catalog.md5(pg_catalog.pg_get_constraintdef(constraint_row.oid,true))
            IS DISTINCT FROM expected.definition_digest
  ) THEN
    RETURN false;
  END IF;

  IF (
    SELECT pg_catalog.count(*) FROM pg_catalog.pg_index AS index_row
    WHERE index_row.indrelid IN (
      'public.post_media_coverage_config'::regclass,
      'public.post_media_coverage_runs'::regclass,
      'public.post_media_coverage_targets'::regclass,
      'public.post_media_coverage_attempts'::regclass,
      'public.post_media_coverage_references'::regclass
    )
  ) <> 13 OR EXISTS (
    SELECT 1
    FROM (VALUES
      ('post_media_coverage_config','post_media_coverage_config_pkey','72f64abf22e074229d663828f32600f1',true,true,false,false,1),
      ('post_media_coverage_runs','post_media_coverage_runs_pkey','ca0386d2d8a7da5c26c5454188e51d59',true,true,false,false,1),
      ('post_media_coverage_runs','post_media_coverage_runs_operation_key','a89104ce653aadcafd58f940415866d9',true,false,false,false,1),
      ('post_media_coverage_runs','post_media_coverage_runs_generation_key','1e0fa32592d2ccc6748035b7a6faf8a2',true,false,false,false,1),
      ('post_media_coverage_runs','post_media_coverage_one_active_idx','f260847d3cfa52cd0f1ea959ec2b41db',true,false,true,true,1),
      ('post_media_coverage_runs','post_media_coverage_runs_latest_idx','95052172c9acdea57e3ef71ff2a71232',false,false,false,false,2),
      ('post_media_coverage_targets','post_media_coverage_targets_pkey','7aa85fabeacc98381ffbbc99585834c9',true,true,false,false,3),
      ('post_media_coverage_targets','post_media_coverage_targets_queue_idx','0b8eb5269d0f5653f9498e1bc961b712',false,false,false,false,4),
      ('post_media_coverage_targets','post_media_coverage_targets_gate_idx','10037fda56ecf6f7dfae739237640e73',false,false,false,false,5),
      ('post_media_coverage_attempts','post_media_coverage_attempts_pkey','cec2eb5fe3686c8cd1cd4a6854d04a2b',true,true,false,false,4),
      ('post_media_coverage_references','post_media_coverage_references_pkey','d0d345a8416abf85b2fb70d96779f3f0',true,true,false,false,5),
      ('post_media_coverage_references','post_media_coverage_references_object_idx','43f1b485c097f7e6e0594474a65a63b1',false,false,true,false,4),
      ('post_media_coverage_references','post_media_coverage_references_finding_idx','49a0d7b5fc59f5a35e7ee3fdbd1a7ce1',false,false,false,false,4)
    ) AS expected(table_name,index_name,definition_digest,is_unique,is_primary,has_predicate,has_expression,key_count)
    LEFT JOIN pg_catalog.pg_class AS index_relation
      ON index_relation.relnamespace='public'::regnamespace
     AND index_relation.relname=expected.index_name
    LEFT JOIN pg_catalog.pg_index AS index_row
      ON index_row.indexrelid=index_relation.oid
     AND index_row.indrelid=pg_catalog.to_regclass('public.' || expected.table_name)
    LEFT JOIN pg_catalog.pg_am AS access_method ON access_method.oid=index_relation.relam
    WHERE index_row.indexrelid IS NULL
       OR index_relation.relkind<>'i'
       OR index_relation.relpersistence<>'p'
       OR index_relation.relowner<>pg_catalog.to_regrole('postgres')
       OR access_method.amname<>'btree'
       OR index_row.indisunique IS DISTINCT FROM expected.is_unique
       OR index_row.indisprimary IS DISTINCT FROM expected.is_primary
       OR (index_row.indpred IS NOT NULL) IS DISTINCT FROM expected.has_predicate
       OR (index_row.indexprs IS NOT NULL) IS DISTINCT FROM expected.has_expression
       OR index_row.indnkeyatts<>expected.key_count
       OR index_row.indnatts<>expected.key_count
       OR NOT index_row.indisvalid OR NOT index_row.indisready OR NOT index_row.indislive
       OR NOT index_row.indimmediate
       OR index_row.indisclustered OR index_row.indisreplident OR index_row.indisexclusion
       OR index_row.indnullsnotdistinct
       OR pg_catalog.md5(pg_catalog.pg_get_indexdef(index_row.indexrelid))
            IS DISTINCT FROM expected.definition_digest
  ) THEN
    RETURN false;
  END IF;

  RETURN (
    SELECT pg_catalog.count(*) = 3
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.contype = 'f'
      AND constraint_row.conrelid IN (
        'public.post_media_coverage_targets'::regclass,
        'public.post_media_coverage_attempts'::regclass,
        'public.post_media_coverage_references'::regclass
      )
      AND constraint_row.confdeltype = 'r'
      AND constraint_row.confupdtype = 'r'
      AND constraint_row.convalidated
      AND NOT constraint_row.condeferrable
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.contype = 'f'
      AND constraint_row.conrelid IN (
        'public.post_media_coverage_config'::regclass,
        'public.post_media_coverage_runs'::regclass
      )
  );
END
$function$;

CREATE OR REPLACE FUNCTION pg_temp.post_media_coverage_publication_is_exact()
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $function$
  WITH expected(signature, argument_names, return_type, service_exposed, prefix, source_digest) AS (
    VALUES
      ('public.install_post_media_coverage_origin_atomic(text)', ARRAY['p_storage_origin']::text[], 'jsonb'::regtype, false, 'post-media-coverage:install-v1:', 'b9ec85013684b3afdfdb211af7dd832e'),
      ('public.classify_post_media_reference_lexical_internal(text,uuid,text,text)', ARRAY['p_reference','p_owner_id','p_reference_kind','p_storage_origin']::text[], 'jsonb'::regtype, false, 'post-media-coverage:classify-v1:', 'cb79baf8c386f7f5609577815e0da5a6'),
      ('public.start_post_media_coverage_inventory_atomic(uuid)', ARRAY['p_operation_id']::text[], 'jsonb'::regtype, true, 'post-media-coverage:start-v1:', '769212ff023bded3f10ff4210aaca581'),
      ('public.enqueue_post_media_coverage_inventory_atomic(uuid,integer)', ARRAY['p_run_id','p_limit']::text[], 'jsonb'::regtype, true, 'post-media-coverage:enqueue-v1:', 'a59266eb4c13e8a7d33f88b43c82f1c1'),
      ('public.observe_post_media_coverage_inventory_atomic(uuid,integer)', ARRAY['p_run_id','p_limit']::text[], 'jsonb'::regtype, true, 'post-media-coverage:observe-v1:', '5b2932757927799d04d885443a03f51d'),
      ('public.seal_post_media_coverage_inventory_atomic(uuid,integer)', ARRAY['p_run_id','p_limit']::text[], 'jsonb'::regtype, true, 'post-media-coverage:seal-v1:', '76c473b3d26348fdbb64745f1e086f2f'),
      ('public.read_post_media_coverage_gate_atomic(uuid,text)', ARRAY['p_run_id','p_scope']::text[], 'jsonb'::regtype, true, 'post-media-coverage:gate-v1:', 'eb5b103bf6034ba4ff268d352926210b')
  ), resolved AS (
    SELECT expected.*, pg_catalog.to_regprocedure(expected.signature) AS function_oid
    FROM expected
  )
  SELECT NOT EXISTS (
    SELECT 1 FROM resolved AS expected
    LEFT JOIN pg_catalog.pg_proc AS function_row ON function_row.oid = expected.function_oid
    WHERE function_row.oid IS NULL
       OR function_row.pronamespace <> 'public'::regnamespace
       OR function_row.prokind <> 'f'
       OR function_row.proowner <> pg_catalog.to_regrole('postgres')
       OR NOT function_row.prosecdef
       OR function_row.provolatile <> 'v'
       OR function_row.prolang <> (SELECT oid FROM pg_catalog.pg_language WHERE lanname = 'plpgsql')
       OR function_row.prorettype <> expected.return_type
       OR function_row.proretset OR function_row.proisstrict
       OR function_row.proparallel <> 'u' OR function_row.proleakproof
       OR function_row.pronargs <> pg_catalog.cardinality(expected.argument_names)
       OR function_row.pronargdefaults <> 0
       OR function_row.proargdefaults IS NOT NULL
       OR function_row.proargnames IS DISTINCT FROM expected.argument_names
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
         'lock_timeout=5s', 'statement_timeout=30s', 'TimeZone=UTC'
       ]::text[]
       OR pg_catalog.md5(function_row.prosrc) IS DISTINCT FROM expected.source_digest
       OR pg_catalog.obj_description(function_row.oid, 'pg_proc') IS DISTINCT FROM expected.prefix || expected.source_digest
  ) AND NOT EXISTS (
    SELECT 1 FROM resolved AS expected
    JOIN pg_catalog.pg_proc AS function_row ON function_row.oid = expected.function_oid
    CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(
      function_row.proacl, pg_catalog.acldefault('f', function_row.proowner)
    )) AS acl_entry
    WHERE acl_entry.grantee <> function_row.proowner
      AND (NOT expected.service_exposed
        OR acl_entry.grantee <> pg_catalog.to_regrole('service_role')
        OR acl_entry.privilege_type <> 'EXECUTE' OR acl_entry.is_grantable)
  ) AND NOT EXISTS (
    SELECT 1 FROM resolved AS expected
    WHERE (SELECT pg_catalog.count(*)
      FROM pg_catalog.pg_proc AS function_row
      CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(
        function_row.proacl, pg_catalog.acldefault('f', function_row.proowner)
      )) AS acl_entry
      WHERE function_row.oid = expected.function_oid
        AND acl_entry.grantee = pg_catalog.to_regrole('service_role')
        AND acl_entry.privilege_type = 'EXECUTE' AND NOT acl_entry.is_grantable
    ) <> CASE WHEN expected.service_exposed THEN 1 ELSE 0 END
  ) AND (
    SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.pronamespace = 'public'::regnamespace
      AND (function_row.proname LIKE '%post\_media\_coverage%' ESCAPE '\'
        OR function_row.proname='classify_post_media_reference_lexical_internal')
  ) = 7
$function$;

DO $preflight$
DECLARE
  v_existing_tables integer;
  v_existing_functions integer;
BEGIN
  IF pg_catalog.current_setting('server_version_num')::integer / 10000 <> 17 THEN
    RAISE EXCEPTION 'post media coverage inventory requires PostgreSQL 17';
  END IF;
  IF NOT pg_temp.post_media_coverage_role_graph_is_safe() THEN
    RAISE EXCEPTION 'post media coverage role graph is unsafe';
  END IF;
  IF pg_catalog.to_regprocedure('auth.role()') IS NULL
     OR pg_catalog.to_regclass('public.posts') IS NULL
     OR pg_catalog.to_regclass('public.group_applications') IS NULL
     OR pg_catalog.to_regclass('public.groups') IS NULL
     OR pg_catalog.to_regclass('public.post_media_uploads') IS NULL
     OR pg_catalog.to_regclass('public.post_media_claim_sets') IS NULL
     OR pg_catalog.to_regclass('public.post_media_claims') IS NULL
     OR pg_catalog.to_regclass('storage.objects') IS NULL
  THEN
    RAISE EXCEPTION 'post media coverage foundations are unavailable';
  END IF;

  SELECT pg_catalog.count(*) INTO v_existing_tables
  FROM pg_catalog.pg_class AS relation
  WHERE relation.oid IN (
    pg_catalog.to_regclass('public.post_media_coverage_config'),
    pg_catalog.to_regclass('public.post_media_coverage_runs'),
    pg_catalog.to_regclass('public.post_media_coverage_targets'),
    pg_catalog.to_regclass('public.post_media_coverage_attempts'),
    pg_catalog.to_regclass('public.post_media_coverage_references')
  );
  SELECT pg_catalog.count(*) INTO v_existing_functions
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.pronamespace = 'public'::regnamespace
    AND function_row.proname IN (
      'install_post_media_coverage_origin_atomic',
      'classify_post_media_reference_lexical_internal',
      'start_post_media_coverage_inventory_atomic',
      'enqueue_post_media_coverage_inventory_atomic',
      'observe_post_media_coverage_inventory_atomic',
      'seal_post_media_coverage_inventory_atomic',
      'read_post_media_coverage_gate_atomic'
    );
  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_class AS relation
    WHERE relation.relnamespace='public'::regnamespace
      AND relation.relname LIKE 'post\_media\_coverage\_%' ESCAPE '\'
      AND relation.relkind NOT IN ('i','I')
  ) <> v_existing_tables OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.pronamespace='public'::regnamespace
      AND (function_row.proname LIKE '%post\_media\_coverage%' ESCAPE '\'
        OR function_row.proname='classify_post_media_reference_lexical_internal')
  ) <> v_existing_functions THEN
    RAISE EXCEPTION 'post media coverage publication is partial';
  END IF;
  IF (v_existing_tables,v_existing_functions) NOT IN ((0,0),(5,7)) THEN
    RAISE EXCEPTION 'post media coverage publication is partial';
  END IF;

  -- Fixed migration lock order: source rows, upload/Storage identity, claims,
  -- then existing evidence relations in ACCESS EXCLUSIVE mode.
  LOCK TABLE public.posts, public.group_applications, public.groups IN SHARE MODE NOWAIT;
  LOCK TABLE public.post_media_uploads, storage.objects IN SHARE MODE NOWAIT;
  LOCK TABLE public.post_media_claim_sets, public.post_media_claims IN SHARE MODE NOWAIT;
  IF NOT pg_temp.post_media_coverage_foundations_are_exact() THEN
    RAISE EXCEPTION 'post media coverage dependency catalog or authority drifted';
  END IF;
  IF v_existing_tables = 5 THEN
    LOCK TABLE public.post_media_coverage_config,
      public.post_media_coverage_runs,
      public.post_media_coverage_targets,
      public.post_media_coverage_attempts,
      public.post_media_coverage_references IN ACCESS EXCLUSIVE MODE NOWAIT;
    IF NOT pg_temp.post_media_coverage_tables_are_exact()
       OR NOT pg_temp.post_media_coverage_publication_is_exact()
    THEN
      RAISE EXCEPTION 'post media coverage existing publication drifted';
    END IF;
  END IF;

  IF EXISTS (
    SELECT 1 FROM (
      VALUES
        ('posts','id','uuid'::regtype), ('posts','author_id','uuid'::regtype),
        ('posts','content','text'::regtype), ('posts','images','text[]'::regtype),
        ('posts','content_version','bigint'::regtype), ('posts','deleted_at','timestamptz'::regtype),
        ('posts','status','public.post_status'::regtype),
        ('group_applications','id','uuid'::regtype), ('group_applications','applicant_id','uuid'::regtype),
        ('group_applications','avatar_url','text'::regtype), ('group_applications','status','text'::regtype),
        ('group_applications','group_id','uuid'::regtype),
        ('groups','id','uuid'::regtype), ('groups','created_by','uuid'::regtype),
        ('groups','avatar_url','text'::regtype),
        ('post_media_uploads','upload_id','uuid'::regtype),
        ('post_media_uploads','owner_id','uuid'::regtype),
        ('post_media_uploads','object_name','text'::regtype),
        ('post_media_uploads','purpose','text'::regtype),
        ('post_media_uploads','status','text'::regtype),
        ('post_media_uploads','gc_admitted_at','timestamptz'::regtype),
        ('post_media_claims','upload_id','uuid'::regtype),
        ('post_media_claims','target_kind','text'::regtype),
        ('post_media_claims','target_id','uuid'::regtype),
        ('post_media_claims','reference_kind','text'::regtype),
        ('objects','bucket_id','text'::regtype), ('objects','name','text'::regtype)
    ) AS expected(table_name,column_name,type_oid)
    LEFT JOIN pg_catalog.pg_attribute AS attribute
      ON attribute.attrelid = CASE WHEN expected.table_name='objects'
        THEN 'storage.objects'::regclass
        ELSE pg_catalog.to_regclass('public.' || expected.table_name) END
     AND attribute.attname = expected.column_name AND attribute.attnum > 0
     AND NOT attribute.attisdropped
    WHERE attribute.attname IS NULL OR attribute.atttypid <> expected.type_oid
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_type AS type_row
    JOIN pg_catalog.pg_enum AS enum_row ON enum_row.enumtypid=type_row.oid
    WHERE type_row.oid='public.post_status'::regtype
      AND enum_row.enumlabel='active'
  ) THEN
    RAISE EXCEPTION 'post media coverage source columns drifted';
  END IF;
END
$preflight$;

CREATE TABLE IF NOT EXISTS public.post_media_coverage_config (
  config_id smallint NOT NULL,
  revision bigint NOT NULL,
  storage_origin text NOT NULL,
  origin_fingerprint text NOT NULL,
  classifier_version text NOT NULL,
  installed_at timestamptz NOT NULL,
  CONSTRAINT post_media_coverage_config_pkey PRIMARY KEY (config_id),
  CONSTRAINT post_media_coverage_config_singleton_check CHECK (config_id = 1),
  CONSTRAINT post_media_coverage_config_revision_check CHECK (revision = 1),
  CONSTRAINT post_media_coverage_config_origin_check CHECK (
    storage_origin = pg_catalog.btrim(storage_origin)
    AND pg_catalog.octet_length(storage_origin) BETWEEN 10 AND 512
    AND origin_fingerprint ~ '^[0-9a-f]{64}$'
    AND classifier_version = 'pg-lexical-v1'
    AND pg_catalog.isfinite(installed_at)
  )
) USING heap;

CREATE TABLE IF NOT EXISTS public.post_media_coverage_runs (
  run_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  generation bigint NOT NULL,
  config_revision bigint NOT NULL,
  storage_origin text NOT NULL,
  origin_fingerprint text NOT NULL,
  classifier_version text NOT NULL,
  state text NOT NULL,
  cursor_kind text NOT NULL,
  cursor_id uuid NOT NULL,
  started_at timestamptz NOT NULL,
  reconciling_at timestamptz,
  sealed_at timestamptz,
  population_fingerprint text,
  target_count integer NOT NULL,
  observed_count integer NOT NULL,
  post_edit_count integer NOT NULL,
  group_review_count integer NOT NULL,
  group_avatar_count integer NOT NULL,
  audit_only_count integer NOT NULL,
  empty_count integer NOT NULL,
  external_only_count integer NOT NULL,
  covered_count integer NOT NULL,
  quarantined_count integer NOT NULL,
  source_absent_count integer NOT NULL,
  claimable_count integer NOT NULL,
  conflicting_count integer NOT NULL,
  cursor_started boolean NOT NULL,
  CONSTRAINT post_media_coverage_runs_pkey PRIMARY KEY (run_id),
  CONSTRAINT post_media_coverage_runs_operation_key UNIQUE (operation_id),
  CONSTRAINT post_media_coverage_runs_generation_key UNIQUE (generation),
  CONSTRAINT post_media_coverage_runs_snapshot_check CHECK (
    generation > 0 AND config_revision = 1
    AND origin_fingerprint ~ '^[0-9a-f]{64}$'
    AND classifier_version = 'pg-lexical-v1'
  ),
  CONSTRAINT post_media_coverage_runs_state_check CHECK (
    state IN ('building','reconciling','sealed')
    AND cursor_kind IN ('post','group_application','group','done')
    AND (cursor_started OR cursor_id='00000000-0000-0000-0000-000000000000'::uuid)
    AND ((state = 'building' AND cursor_kind <> 'done'
          AND reconciling_at IS NULL AND sealed_at IS NULL
          AND population_fingerprint IS NULL)
      OR (state = 'reconciling' AND cursor_kind IN ('post','group_application','group')
          AND reconciling_at IS NOT NULL AND sealed_at IS NULL
          AND population_fingerprint ~ '^[0-9a-f]{64}$')
      OR (state = 'sealed' AND cursor_kind = 'done'
          AND cursor_started
          AND reconciling_at IS NOT NULL AND sealed_at IS NOT NULL
          AND population_fingerprint ~ '^[0-9a-f]{64}$'))
  ),
  CONSTRAINT post_media_coverage_runs_time_check CHECK (
    pg_catalog.isfinite(started_at)
    AND (reconciling_at IS NULL OR (pg_catalog.isfinite(reconciling_at) AND reconciling_at >= started_at))
    AND (sealed_at IS NULL OR (pg_catalog.isfinite(sealed_at) AND sealed_at >= reconciling_at))
  ),
  CONSTRAINT post_media_coverage_runs_count_check CHECK (
    target_count >= 0 AND observed_count BETWEEN 0 AND target_count
    AND post_edit_count >= 0 AND group_review_count >= 0
    AND group_avatar_count >= 0 AND audit_only_count >= 0
    AND empty_count >= 0 AND external_only_count >= 0 AND covered_count >= 0
    AND quarantined_count >= 0 AND source_absent_count >= 0
    AND claimable_count >= 0 AND conflicting_count >= 0
  )
) USING heap;

CREATE UNIQUE INDEX IF NOT EXISTS post_media_coverage_one_active_idx
  ON public.post_media_coverage_runs ((1))
  WHERE state IN ('building','reconciling');
CREATE INDEX IF NOT EXISTS post_media_coverage_runs_latest_idx
  ON public.post_media_coverage_runs (generation DESC, run_id);

CREATE TABLE IF NOT EXISTS public.post_media_coverage_targets (
  run_id uuid NOT NULL,
  target_kind text NOT NULL,
  target_id uuid NOT NULL,
  attempt integer NOT NULL,
  queue_state text NOT NULL,
  source_owner_id uuid,
  source_revision bigint,
  source_status text,
  source_group_id uuid,
  source_fingerprint text NOT NULL,
  link_fingerprint text NOT NULL,
  eligibility text NOT NULL,
  coverage_state text,
  claim_state text,
  manifest_fingerprint text,
  reference_count integer NOT NULL,
  managed_count integer NOT NULL,
  external_count integer NOT NULL,
  blockers text[] NOT NULL,
  enqueued_at timestamptz NOT NULL,
  observed_at timestamptz,
  CONSTRAINT post_media_coverage_targets_pkey PRIMARY KEY (run_id,target_kind,target_id),
  CONSTRAINT post_media_coverage_targets_run_fkey FOREIGN KEY (run_id)
    REFERENCES public.post_media_coverage_runs(run_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT post_media_coverage_targets_kind_check CHECK (
    target_kind IN ('post','group_application','group')
  ),
  CONSTRAINT post_media_coverage_targets_queue_check CHECK (
    attempt BETWEEN 1 AND 2147483647
    AND queue_state IN ('queued','stale','observed')
  ),
  CONSTRAINT post_media_coverage_targets_evidence_check CHECK (
    source_fingerprint ~ '^[0-9a-f]{64}$'
    AND link_fingerprint ~ '^[0-9a-f]{64}$'
    AND eligibility IN ('post_edit','group_review','group_avatar_audit','audit_only','source_absent')
    AND reference_count >= 0 AND managed_count BETWEEN 0 AND reference_count
    AND external_count BETWEEN 0 AND reference_count
    AND pg_catalog.cardinality(blockers) BETWEEN 0 AND 64
    AND pg_catalog.isfinite(enqueued_at)
    AND ((queue_state IN ('queued','stale') AND coverage_state IS NULL
          AND claim_state IS NULL AND manifest_fingerprint IS NULL AND observed_at IS NULL
          AND reference_count = 0 AND managed_count = 0 AND external_count = 0
          AND blockers = ARRAY[]::text[])
      OR (queue_state = 'observed'
          AND coverage_state IN ('empty','external_only','covered','quarantined','source_absent')
          AND claim_state IN ('not_applicable','fully_claimed','claimable','conflicting')
          AND manifest_fingerprint ~ '^[0-9a-f]{64}$'
          AND pg_catalog.isfinite(observed_at)))
  )
) USING heap;

CREATE INDEX IF NOT EXISTS post_media_coverage_targets_queue_idx
  ON public.post_media_coverage_targets (run_id,queue_state,target_kind,target_id);
CREATE INDEX IF NOT EXISTS post_media_coverage_targets_gate_idx
  ON public.post_media_coverage_targets (run_id,eligibility,coverage_state,claim_state,target_id);

CREATE TABLE IF NOT EXISTS public.post_media_coverage_attempts (
  run_id uuid NOT NULL,
  target_kind text NOT NULL,
  target_id uuid NOT NULL,
  attempt integer NOT NULL,
  source_owner_id uuid,
  source_revision bigint,
  source_status text,
  source_group_id uuid,
  source_fingerprint text NOT NULL,
  link_fingerprint text NOT NULL,
  eligibility text NOT NULL,
  coverage_state text,
  claim_state text,
  manifest_fingerprint text,
  reference_count integer NOT NULL,
  managed_count integer NOT NULL,
  external_count integer NOT NULL,
  blockers text[] NOT NULL,
  observed_at timestamptz,
  CONSTRAINT post_media_coverage_attempts_pkey
    PRIMARY KEY (run_id,target_kind,target_id,attempt),
  CONSTRAINT post_media_coverage_attempts_target_fkey
    FOREIGN KEY (run_id,target_kind,target_id)
    REFERENCES public.post_media_coverage_targets(run_id,target_kind,target_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT post_media_coverage_attempts_evidence_check CHECK (
    target_kind IN ('post','group_application','group')
    AND attempt BETWEEN 1 AND 2147483647
    AND source_fingerprint ~ '^[0-9a-f]{64}$'
    AND link_fingerprint ~ '^[0-9a-f]{64}$'
    AND eligibility IN ('post_edit','group_review','group_avatar_audit','audit_only','source_absent')
    AND reference_count >= 0 AND managed_count BETWEEN 0 AND reference_count
    AND external_count BETWEEN 0 AND reference_count
    AND pg_catalog.cardinality(blockers) BETWEEN 0 AND 64
    AND ((observed_at IS NULL AND coverage_state IS NULL AND claim_state IS NULL
          AND manifest_fingerprint IS NULL AND reference_count=0
          AND managed_count=0 AND external_count=0 AND blockers=ARRAY[]::text[])
      OR (pg_catalog.isfinite(observed_at)
          AND coverage_state IN ('empty','external_only','covered','quarantined','source_absent')
          AND claim_state IN ('not_applicable','fully_claimed','claimable','conflicting')
          AND manifest_fingerprint ~ '^[0-9a-f]{64}$'))
  )
) USING heap;

CREATE TABLE IF NOT EXISTS public.post_media_coverage_references (
  run_id uuid NOT NULL,
  target_kind text NOT NULL,
  target_id uuid NOT NULL,
  attempt integer NOT NULL,
  reference_key text NOT NULL,
  source_mask integer NOT NULL,
  occurrences integer NOT NULL,
  raw_sha256 text NOT NULL,
  raw_length integer NOT NULL,
  classification text NOT NULL,
  expected_reference_kind text NOT NULL,
  object_name text,
  upload_id uuid,
  registry_state text NOT NULL,
  storage_state text NOT NULL,
  claim_state text NOT NULL,
  finding text NOT NULL,
  observed_at timestamptz NOT NULL,
  CONSTRAINT post_media_coverage_references_pkey
    PRIMARY KEY (run_id,target_kind,target_id,attempt,reference_key),
  CONSTRAINT post_media_coverage_references_attempt_fkey
    FOREIGN KEY (run_id,target_kind,target_id,attempt)
    REFERENCES public.post_media_coverage_attempts(run_id,target_kind,target_id,attempt)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT post_media_coverage_references_identity_check CHECK (
    target_kind IN ('post','group_application','group')
    AND attempt BETWEEN 1 AND 2147483647
    AND reference_key ~ '^[0-9a-f]{64}$'
    AND raw_sha256 ~ '^[0-9a-f]{64}$'
    AND raw_length BETWEEN 0 AND 2147483647
    AND source_mask BETWEEN 1 AND 7
    AND occurrences BETWEEN 1 AND 1000000
  ),
  CONSTRAINT post_media_coverage_references_classification_check CHECK (
    classification IN ('canonical_managed','external','malformed_or_ambiguous')
    AND expected_reference_kind IN ('post_image','post_video','group_avatar')
    AND registry_state IN ('not_applicable','unregistered','reserved','uploaded','gc_admitted','wrong_owner','wrong_purpose')
    AND storage_state IN ('not_applicable','missing','present')
    AND claim_state IN ('not_applicable','missing','matched','conflicting')
    AND pg_catalog.octet_length(finding) BETWEEN 2 AND 256
    AND pg_catalog.isfinite(observed_at)
    AND ((classification = 'canonical_managed' AND object_name IS NOT NULL)
      OR (classification <> 'canonical_managed' AND object_name IS NULL
          AND upload_id IS NULL AND registry_state = 'not_applicable'
          AND storage_state = 'not_applicable' AND claim_state = 'not_applicable'))
  )
) USING heap;

CREATE INDEX IF NOT EXISTS post_media_coverage_references_object_idx
  ON public.post_media_coverage_references (object_name,run_id,target_kind,target_id)
  WHERE object_name IS NOT NULL;
CREATE INDEX IF NOT EXISTS post_media_coverage_references_finding_idx
  ON public.post_media_coverage_references (run_id,finding,target_kind,target_id);

ALTER TABLE public.post_media_coverage_config OWNER TO postgres;
ALTER TABLE public.post_media_coverage_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.post_media_coverage_config FORCE ROW LEVEL SECURITY;
ALTER TABLE public.post_media_coverage_runs OWNER TO postgres;
ALTER TABLE public.post_media_coverage_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.post_media_coverage_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE public.post_media_coverage_targets OWNER TO postgres;
ALTER TABLE public.post_media_coverage_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.post_media_coverage_targets FORCE ROW LEVEL SECURITY;
ALTER TABLE public.post_media_coverage_attempts OWNER TO postgres;
ALTER TABLE public.post_media_coverage_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.post_media_coverage_attempts FORCE ROW LEVEL SECURITY;
ALTER TABLE public.post_media_coverage_references OWNER TO postgres;
ALTER TABLE public.post_media_coverage_references ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.post_media_coverage_references FORCE ROW LEVEL SECURITY;

DO $converge_private_table_acl$
DECLARE
  v_relation regclass;
  v_grantee record;
  v_columns text;
  v_policy name;
BEGIN
  FOREACH v_relation IN ARRAY ARRAY[
    'public.post_media_coverage_config'::regclass,
    'public.post_media_coverage_runs'::regclass,
    'public.post_media_coverage_targets'::regclass,
    'public.post_media_coverage_attempts'::regclass,
    'public.post_media_coverage_references'::regclass
  ]
  LOOP
    FOR v_grantee IN
      SELECT DISTINCT acl_entry.grantee, role_row.rolname
      FROM pg_catalog.pg_class AS relation
      CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(
        relation.relacl, pg_catalog.acldefault('r', relation.relowner)
      )) AS acl_entry
      LEFT JOIN pg_catalog.pg_roles AS role_row ON role_row.oid = acl_entry.grantee
      WHERE relation.oid = v_relation AND acl_entry.grantee <> relation.relowner
    LOOP
      IF v_grantee.grantee = 0 THEN
        EXECUTE pg_catalog.format('REVOKE ALL ON TABLE %s FROM PUBLIC CASCADE', v_relation);
      ELSIF v_grantee.rolname IS NOT NULL THEN
        EXECUTE pg_catalog.format('REVOKE ALL ON TABLE %s FROM %I CASCADE', v_relation, v_grantee.rolname);
      END IF;
    END LOOP;

    SELECT pg_catalog.string_agg(pg_catalog.format('%I', attribute.attname), ', ' ORDER BY attribute.attnum)
    INTO STRICT v_columns
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = v_relation AND attribute.attnum > 0 AND NOT attribute.attisdropped;
    FOR v_grantee IN
      SELECT DISTINCT acl_entry.grantee, role_row.rolname
      FROM pg_catalog.pg_attribute AS attribute
      CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl_entry
      LEFT JOIN pg_catalog.pg_roles AS role_row ON role_row.oid = acl_entry.grantee
      WHERE attribute.attrelid = v_relation AND attribute.attnum > 0
        AND NOT attribute.attisdropped AND acl_entry.grantee <> pg_catalog.to_regrole('postgres')
    LOOP
      IF v_grantee.grantee = 0 THEN
        EXECUTE pg_catalog.format(
          'REVOKE SELECT (%1$s), INSERT (%1$s), UPDATE (%1$s), REFERENCES (%1$s) ON TABLE %2$s FROM PUBLIC CASCADE',
          v_columns, v_relation
        );
      ELSIF v_grantee.rolname IS NOT NULL THEN
        EXECUTE pg_catalog.format(
          'REVOKE SELECT (%1$s), INSERT (%1$s), UPDATE (%1$s), REFERENCES (%1$s) ON TABLE %2$s FROM %3$I CASCADE',
          v_columns, v_relation, v_grantee.rolname
        );
      END IF;
    END LOOP;
    FOR v_policy IN SELECT policy.polname FROM pg_catalog.pg_policy AS policy WHERE policy.polrelid = v_relation
    LOOP
      EXECUTE pg_catalog.format('DROP POLICY %I ON %s', v_policy, v_relation);
    END LOOP;
  END LOOP;
END
$converge_private_table_acl$;

CREATE OR REPLACE FUNCTION public.install_post_media_coverage_origin_atomic(
  p_storage_origin text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
SET lock_timeout = '5s'
SET statement_timeout = '30s'
SET TimeZone = 'UTC'
AS $function$
DECLARE
  v_existing public.post_media_coverage_config%ROWTYPE;
  v_fingerprint text;
  v_port text;
  v_host text;
BEGIN
  IF SESSION_USER <> 'postgres'
     AND NOT pg_catalog.pg_has_role(SESSION_USER, 'postgres', 'SET')
  THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'postgres owner required';
  END IF;
  IF NOT pg_catalog.pg_try_advisory_xact_lock_shared(
    pg_catalog.hashtextextended('public-post-media-claims@1', 0)
  ) OR NOT pg_catalog.pg_try_advisory_xact_lock_shared(
    pg_catalog.hashtextextended('public-post-media-coverage@1', 0)
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '55P03', MESSAGE = 'post media coverage migration is active';
  END IF;
  IF p_storage_origin IS NULL
     OR p_storage_origin IS DISTINCT FROM pg_catalog.btrim(p_storage_origin)
     OR pg_catalog.octet_length(p_storage_origin) NOT BETWEEN 10 AND 512
     OR p_storage_origin !~ '^https?://[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[0-9]{1,5})?$'
     OR p_storage_origin ~ '[[:cntrl:][:space:]@%\\?#]'
     OR p_storage_origin ~ '\.\.'
     OR p_storage_origin ~ ':0[0-9]+$'
     OR p_storage_origin ~ '^https://[^/]+:0*443$'
     OR p_storage_origin ~ '^http://[^/]+:0*80$'
  THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid canonical post media Storage origin';
  END IF;
  v_port := pg_catalog.substring(p_storage_origin, ':([0-9]+)$');
  IF v_port IS NOT NULL AND (v_port::numeric < 1 OR v_port::numeric > 65535) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid canonical post media Storage port';
  END IF;
  v_host := pg_catalog.regexp_replace(
    pg_catalog.regexp_replace(p_storage_origin, '^https?://', ''), ':[0-9]+$', ''
  );
  IF pg_catalog.octet_length(v_host) > 253
     OR v_host !~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$'
  THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid canonical post media Storage host';
  END IF;
  v_fingerprint := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(p_storage_origin, 'UTF8')), 'hex'
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('post-media-coverage-config:1', 0)
  );
  SELECT * INTO v_existing
  FROM public.post_media_coverage_config AS config_row
  WHERE config_row.config_id = 1
  FOR UPDATE;
  IF FOUND THEN
    IF v_existing.storage_origin IS DISTINCT FROM p_storage_origin
       OR v_existing.origin_fingerprint IS DISTINCT FROM v_fingerprint
       OR v_existing.revision IS DISTINCT FROM 1
       OR v_existing.classifier_version IS DISTINCT FROM 'pg-lexical-v1'
    THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'post media coverage origin is immutable';
    END IF;
    RETURN pg_catalog.jsonb_build_object(
      'status','replayed','applied',false,'revision',v_existing.revision,
      'origin_fingerprint',v_existing.origin_fingerprint
    );
  END IF;
  INSERT INTO public.post_media_coverage_config(
    config_id,revision,storage_origin,origin_fingerprint,classifier_version,installed_at
  ) VALUES (1,1,p_storage_origin,v_fingerprint,'pg-lexical-v1',pg_catalog.statement_timestamp());
  RETURN pg_catalog.jsonb_build_object(
    'status','installed','applied',true,'revision',1,'origin_fingerprint',v_fingerprint
  );
END
$function$;

CREATE OR REPLACE FUNCTION public.classify_post_media_reference_lexical_internal(
  p_reference text,
  p_owner_id uuid,
  p_reference_kind text,
  p_storage_origin text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
SET lock_timeout = '5s'
SET statement_timeout = '30s'
SET TimeZone = 'UTC'
AS $function$
DECLARE
  v_prefix text := p_storage_origin || '/storage/v1/object/public/posts/';
  v_object_name text;
  v_reference_origin text;
  v_reference_authority text;
  v_reference_host text;
  v_reference_port text;
  v_storage_authority text;
  v_storage_host text;
  v_storage_direct_host text;
BEGIN
  IF p_reference_kind IS NULL
     OR p_reference_kind NOT IN ('post_image','post_video','group_avatar')
     OR p_storage_origin IS NULL
  THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid lexical classifier context';
  END IF;
  IF p_reference IS NULL OR p_reference = ''
     OR p_reference IS DISTINCT FROM pg_catalog.btrim(p_reference)
     OR pg_catalog.octet_length(p_reference) > 2048
     OR p_reference ~ '[[:cntrl:]]'
     OR p_reference ~ U&'[\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]'
     OR p_reference ~ '[{}|^]'
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'classification','malformed_or_ambiguous','object_name',NULL,'finding','malformed_reference'
    );
  END IF;

  IF pg_catalog.left(p_reference, pg_catalog.length(v_prefix)) = v_prefix THEN
    v_object_name := pg_catalog.substring(p_reference, pg_catalog.length(v_prefix) + 1);
    IF pg_catalog.octet_length(v_object_name) NOT BETWEEN 1 AND 512
       OR v_object_name ~ '[[:cntrl:]%?#\\]'
       OR v_object_name ~ '(^/|/$|//|(^|/)\.{1,2}(/|$))'
       OR v_object_name !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/'
    THEN
      RETURN pg_catalog.jsonb_build_object(
        'classification','malformed_or_ambiguous','object_name',NULL,'finding','malformed_managed_path'
      );
    END IF;
    IF p_owner_id IS NULL THEN
      RETURN pg_catalog.jsonb_build_object(
        'classification','malformed_or_ambiguous','object_name',NULL,
        'finding','managed_owner_unavailable'
      );
    END IF;
    IF pg_catalog.left(v_object_name, pg_catalog.length(p_owner_id::text) + 1)
       IS DISTINCT FROM p_owner_id::text || '/'
    THEN
      RETURN pg_catalog.jsonb_build_object(
        'classification','malformed_or_ambiguous','object_name',NULL,'finding','managed_owner_mismatch'
      );
    END IF;
    RETURN pg_catalog.jsonb_build_object(
      'classification','canonical_managed','object_name',v_object_name,'finding','managed_candidate'
    );
  END IF;

  -- pg-lexical-v1 never labels a WHATWG-sensitive spelling external. Percent
  -- hosts, userinfo, backslashes, whitespace, slashless schemes, root dots,
  -- mixed case, and non-canonical default ports all fail closed here.
  IF p_reference ~* '^https?:' THEN
    IF p_reference !~ '^https?://[^/[:space:]<>"''`()\[\]\\@%{}|^]+(?:/[^[:space:]<>"''`()\[\]\\{}|^]*)?$'
    THEN
      RETURN pg_catalog.jsonb_build_object(
        'classification','malformed_or_ambiguous','object_name',NULL,'finding','whatwg_ambiguous'
      );
    END IF;
    v_reference_origin := pg_catalog.substring(p_reference, '^(https?://[^/]+)');
    v_reference_authority := pg_catalog.regexp_replace(
      pg_catalog.lower(v_reference_origin),'^https?://',''
    );
    IF v_reference_authority !~ '^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[0-9]{1,5})?$'
       OR v_reference_authority ~ '\.\.'
    THEN
      RETURN pg_catalog.jsonb_build_object(
        'classification','malformed_or_ambiguous','object_name',NULL,'finding','whatwg_ambiguous'
      );
    END IF;
    v_reference_port := pg_catalog.substring(v_reference_authority, ':([0-9]+)$');
    IF v_reference_port IS NOT NULL
       AND (v_reference_port::numeric < 1
         OR v_reference_port::numeric > 65535
         OR v_reference_port ~ '^0[0-9]+'
         OR (pg_catalog.left(v_reference_origin,8)='https://' AND v_reference_port::numeric=443)
         OR (pg_catalog.left(v_reference_origin,7)='http://' AND v_reference_port::numeric=80))
    THEN
      RETURN pg_catalog.jsonb_build_object(
        'classification','malformed_or_ambiguous','object_name',NULL,'finding','whatwg_ambiguous'
      );
    END IF;
    v_reference_host := pg_catalog.regexp_replace(v_reference_authority, ':[0-9]+$','');
    IF pg_catalog.octet_length(v_reference_host) > 253
       OR v_reference_host !~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$'
       OR v_reference_host !~ '[a-z]'
    THEN
      RETURN pg_catalog.jsonb_build_object(
        'classification','malformed_or_ambiguous','object_name',NULL,'finding','whatwg_ambiguous'
      );
    END IF;
    v_storage_authority := pg_catalog.regexp_replace(
      pg_catalog.lower(p_storage_origin),'^https?://',''
    );
    v_storage_host := pg_catalog.regexp_replace(v_storage_authority, ':[0-9]+$','');
    -- The official direct Storage authority is derivable only for the exact
    -- hosted Supabase project authority. Custom origins and CNAMEs are never
    -- guessed. Any spelling on either trusted internal authority fails closed;
    -- canonical managed identity remains exclusive to v_prefix above.
    IF v_storage_host ~ '^[a-z0-9-]+\.supabase\.co$' THEN
      v_storage_direct_host := pg_catalog.substring(
        v_storage_host,'^([a-z0-9-]+)\.supabase\.co$'
      ) || '.storage.supabase.co';
    END IF;
    IF v_reference_host = v_storage_host
       OR v_reference_host = v_storage_direct_host
    THEN
      RETURN pg_catalog.jsonb_build_object(
        'classification','malformed_or_ambiguous','object_name',NULL,'finding','noncanonical_internal_reference'
      );
    END IF;
    RETURN pg_catalog.jsonb_build_object(
      'classification','external','object_name',NULL,'finding','external_reference'
    );
  END IF;
  RETURN pg_catalog.jsonb_build_object(
    'classification','malformed_or_ambiguous','object_name',NULL,'finding','unsupported_reference'
  );
END
$function$;

CREATE OR REPLACE FUNCTION public.start_post_media_coverage_inventory_atomic(
  p_operation_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
SET lock_timeout = '5s'
SET statement_timeout = '30s'
SET TimeZone = 'UTC'
AS $function$
DECLARE
  v_config public.post_media_coverage_config%ROWTYPE;
  v_existing public.post_media_coverage_runs%ROWTYPE;
  v_generation bigint;
  v_run_id uuid;
BEGIN
  IF COALESCE((SELECT auth.role()), '') <> 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'service role required';
  END IF;
  IF p_operation_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'operation id is required';
  END IF;
  IF NOT pg_catalog.pg_try_advisory_xact_lock_shared(
    pg_catalog.hashtextextended('public-post-media-claims@1', 0)
  ) OR NOT pg_catalog.pg_try_advisory_xact_lock_shared(
    pg_catalog.hashtextextended('public-post-media-coverage@1', 0)
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '55P03', MESSAGE = 'post media coverage migration is active';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('post-media-coverage-operation:' || p_operation_id::text, 0)
  );
  SELECT * INTO v_existing FROM public.post_media_coverage_runs AS run_row
  WHERE run_row.operation_id = p_operation_id;
  IF FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'status','replayed','applied',false,'run_id',v_existing.run_id,
      'generation',v_existing.generation,'state',v_existing.state
    );
  END IF;
  IF EXISTS (SELECT 1 FROM public.post_media_coverage_runs AS run_row WHERE run_row.state IN ('building','reconciling')) THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'post media coverage inventory already active';
  END IF;
  SELECT * INTO v_config FROM public.post_media_coverage_config AS config_row
  WHERE config_row.config_id = 1 FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'post media coverage origin is not installed';
  END IF;
  SELECT COALESCE(pg_catalog.max(run_row.generation),0) + 1
  INTO v_generation FROM public.post_media_coverage_runs AS run_row;
  v_run_id := pg_catalog.gen_random_uuid();
  INSERT INTO public.post_media_coverage_runs(
    run_id,operation_id,generation,config_revision,storage_origin,origin_fingerprint,
    classifier_version,state,cursor_kind,cursor_id,started_at,reconciling_at,sealed_at,
    population_fingerprint,target_count,observed_count,post_edit_count,group_review_count,
    group_avatar_count,audit_only_count,empty_count,external_only_count,covered_count,
    quarantined_count,source_absent_count,claimable_count,conflicting_count
    ,cursor_started
  ) VALUES (
    v_run_id,p_operation_id,v_generation,v_config.revision,v_config.storage_origin,
    v_config.origin_fingerprint,v_config.classifier_version,'building','post',
    '00000000-0000-0000-0000-000000000000',pg_catalog.statement_timestamp(),NULL,NULL,NULL,
    0,0,0,0,0,0,0,0,0,0,0,0,0,false
  );
  RETURN pg_catalog.jsonb_build_object(
    'status','started','applied',true,'run_id',v_run_id,
    'generation',v_generation,'state','building'
  );
END
$function$;

CREATE OR REPLACE FUNCTION public.enqueue_post_media_coverage_inventory_atomic(
  p_run_id uuid,
  p_limit integer
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
SET lock_timeout = '5s'
SET statement_timeout = '30s'
SET TimeZone = 'UTC'
AS $function$
DECLARE
  v_run public.post_media_coverage_runs%ROWTYPE;
  v_count integer := 0;
  v_enqueued_count integer := 0;
  v_last_id uuid;
  v_next_kind text;
BEGIN
  IF COALESCE((SELECT auth.role()), '') <> 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'service role required';
  END IF;
  IF p_run_id IS NULL OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'enqueue limit must be between 1 and 500';
  END IF;
  IF NOT pg_catalog.pg_try_advisory_xact_lock_shared(
    pg_catalog.hashtextextended('public-post-media-claims@1', 0)
  ) OR NOT pg_catalog.pg_try_advisory_xact_lock_shared(
    pg_catalog.hashtextextended('public-post-media-coverage@1', 0)
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '55P03', MESSAGE = 'post media coverage migration is active';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('post-media-coverage-run:' || p_run_id::text, 0)
  );
  SELECT * INTO v_run FROM public.post_media_coverage_runs AS run_row
  WHERE run_row.run_id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'post media coverage run not found';
  END IF;
  IF v_run.state <> 'building' THEN
    RETURN pg_catalog.jsonb_build_object(
      'status','replayed','applied',false,'run_id',p_run_id,'state',v_run.state,
      'cursor_kind',v_run.cursor_kind,'enqueued',0
    );
  END IF;

  IF v_run.cursor_kind = 'post' THEN
    WITH scan_page AS MATERIALIZED (
      SELECT post_row.id
      FROM public.posts AS post_row
      WHERE post_row.id >= CASE WHEN v_run.cursor_started THEN v_run.cursor_id
              ELSE '00000000-0000-0000-0000-000000000000'::uuid END
        AND (NOT v_run.cursor_started OR post_row.id > v_run.cursor_id)
      ORDER BY post_row.id
      LIMIT p_limit
    ), source_rows AS MATERIALIZED (
      SELECT post_row.id,post_row.author_id,post_row.content_version,
        CASE WHEN CASE
          WHEN pg_catalog.pg_column_compression(post_row.images) IS NOT NULL THEN true
          WHEN COALESCE(pg_catalog.pg_column_size(post_row.images),0)>262144 THEN true
          WHEN pg_catalog.octet_length(COALESCE(post_row.content,''))>262144
            OR COALESCE(pg_catalog.cardinality(post_row.images),0)>64 THEN true
          ELSE COALESCE((SELECT pg_catalog.sum(pg_catalog.octet_length(element.value))
            FROM pg_catalog.unnest(COALESCE(post_row.images,ARRAY[]::text[]))
              AS element(value)),0)>262144 END
        THEN pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
          pg_catalog.jsonb_build_array('oversized-post-v2',post_row.author_id,
            post_row.content_version,
            pg_catalog.octet_length(COALESCE(post_row.content,'')),
            COALESCE(pg_catalog.pg_column_compression(post_row.images),'uncompressed'),
            COALESCE(pg_catalog.pg_column_size(post_row.images),0),
            post_row.deleted_at,post_row.status)::text,'UTF8')),'hex')
        ELSE pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
          pg_catalog.jsonb_build_array(post_row.author_id,post_row.content_version,
            post_row.content,post_row.images,post_row.deleted_at,post_row.status)::text,'UTF8')),'hex')
        END AS fingerprint
      FROM scan_page
      JOIN public.posts AS post_row ON post_row.id=scan_page.id
      WHERE post_row.deleted_at IS NULL
        AND post_row.status = 'active'::public.post_status
    ), inserted AS (
      INSERT INTO public.post_media_coverage_targets(
        run_id,target_kind,target_id,attempt,queue_state,source_owner_id,source_revision,
        source_status,source_group_id,source_fingerprint,link_fingerprint,eligibility,
        coverage_state,claim_state,manifest_fingerprint,reference_count,managed_count,
        external_count,blockers,enqueued_at,observed_at
      )
      SELECT p_run_id,'post',source_rows.id,1,'queued',source_rows.author_id,
        source_rows.content_version,'active',NULL,source_rows.fingerprint,
        pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to('post:' || source_rows.id::text,'UTF8')),'hex'),
        'post_edit',NULL,NULL,NULL,0,0,0,ARRAY[]::text[],pg_catalog.statement_timestamp(),NULL
      FROM source_rows ON CONFLICT DO NOTHING RETURNING target_id
    )
    SELECT (SELECT pg_catalog.count(*) FROM scan_page),
      (SELECT (pg_catalog.array_agg(scan_page.id ORDER BY scan_page.id DESC))[1] FROM scan_page),
      (SELECT pg_catalog.count(*) FROM inserted)
    INTO v_count,v_last_id,v_enqueued_count;
    v_next_kind := 'group_application';
  ELSIF v_run.cursor_kind = 'group_application' THEN
    WITH source_rows AS (
      SELECT app_row.id,app_row.applicant_id,app_row.status,app_row.group_id,
        CASE WHEN pg_catalog.octet_length(app_row.status)>256
          THEN 'oversized-status:' || pg_catalog.octet_length(app_row.status)::text
          ELSE app_row.status END AS snapshot_status,
        pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(CASE
          WHEN pg_catalog.octet_length(app_row.status)>256
          THEN pg_catalog.jsonb_build_array('oversized-application-status-v1',app_row.applicant_id,
            pg_catalog.octet_length(app_row.status),
            pg_catalog.octet_length(COALESCE(app_row.avatar_url,'')),app_row.group_id)
          WHEN pg_catalog.octet_length(COALESCE(app_row.avatar_url,''))>262144
          THEN pg_catalog.jsonb_build_array('oversized-application-v1',app_row.applicant_id,
            pg_catalog.octet_length(COALESCE(app_row.avatar_url,'')),app_row.status,app_row.group_id)
          ELSE pg_catalog.jsonb_build_array(app_row.applicant_id,app_row.avatar_url,
            app_row.status,app_row.group_id) END::text,'UTF8')), 'hex') AS fingerprint,
        pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(CASE
          WHEN pg_catalog.octet_length(app_row.status)>256
          THEN pg_catalog.jsonb_build_array('oversized-application-link-status-v1',
            pg_catalog.octet_length(app_row.status),app_row.group_id,linked_group.id,
            linked_group.created_by,
            pg_catalog.octet_length(COALESCE(linked_group.avatar_url,'')))
          WHEN pg_catalog.octet_length(COALESCE(linked_group.avatar_url,''))>262144
          THEN pg_catalog.jsonb_build_array('oversized-application-link-v1',app_row.status,
            app_row.group_id,linked_group.id,linked_group.created_by,
            pg_catalog.octet_length(COALESCE(linked_group.avatar_url,'')))
          ELSE pg_catalog.jsonb_build_array('application-link-v1',app_row.status,
            app_row.group_id,linked_group.id,linked_group.created_by,
            linked_group.avatar_url) END::text,'UTF8')), 'hex') AS link_fingerprint
      FROM public.group_applications AS app_row
      LEFT JOIN public.groups AS linked_group ON linked_group.id=app_row.group_id
      WHERE app_row.id >= CASE WHEN v_run.cursor_started THEN v_run.cursor_id
              ELSE '00000000-0000-0000-0000-000000000000'::uuid END
        AND (NOT v_run.cursor_started OR app_row.id > v_run.cursor_id)
      ORDER BY app_row.id LIMIT p_limit
    ), inserted AS (
      INSERT INTO public.post_media_coverage_targets(
        run_id,target_kind,target_id,attempt,queue_state,source_owner_id,source_revision,
        source_status,source_group_id,source_fingerprint,link_fingerprint,eligibility,
        coverage_state,claim_state,manifest_fingerprint,reference_count,managed_count,
        external_count,blockers,enqueued_at,observed_at
      )
      SELECT p_run_id,'group_application',source_rows.id,1,'queued',source_rows.applicant_id,
        NULL,source_rows.snapshot_status,source_rows.group_id,source_rows.fingerprint,
        source_rows.link_fingerprint,
        CASE WHEN source_rows.snapshot_status = 'pending'
          THEN 'group_review' ELSE 'audit_only' END,
        NULL,NULL,NULL,0,0,0,ARRAY[]::text[],pg_catalog.statement_timestamp(),NULL
      FROM source_rows ON CONFLICT DO NOTHING RETURNING target_id
    )
    SELECT (SELECT pg_catalog.count(*) FROM source_rows),
      (SELECT (pg_catalog.array_agg(source_rows.id ORDER BY source_rows.id DESC))[1] FROM source_rows),
      (SELECT pg_catalog.count(*) FROM inserted)
    INTO v_count,v_last_id,v_enqueued_count;
    v_next_kind := 'group';
  ELSIF v_run.cursor_kind = 'group' THEN
    WITH source_rows AS (
      SELECT group_row.id,group_row.created_by,
        pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(CASE
          WHEN pg_catalog.octet_length(COALESCE(group_row.avatar_url,''))>262144
          THEN pg_catalog.jsonb_build_array('oversized-group-v1',group_row.created_by,
            pg_catalog.octet_length(COALESCE(group_row.avatar_url,'')))
          ELSE pg_catalog.jsonb_build_array(group_row.created_by,group_row.avatar_url)
          END::text,'UTF8')), 'hex') AS fingerprint
      FROM public.groups AS group_row
      WHERE group_row.id >= CASE WHEN v_run.cursor_started THEN v_run.cursor_id
              ELSE '00000000-0000-0000-0000-000000000000'::uuid END
        AND (NOT v_run.cursor_started OR group_row.id > v_run.cursor_id)
      ORDER BY group_row.id LIMIT p_limit
    ), inserted AS (
      INSERT INTO public.post_media_coverage_targets(
        run_id,target_kind,target_id,attempt,queue_state,source_owner_id,source_revision,
        source_status,source_group_id,source_fingerprint,link_fingerprint,eligibility,
        coverage_state,claim_state,manifest_fingerprint,reference_count,managed_count,
        external_count,blockers,enqueued_at,observed_at
      )
      SELECT p_run_id,'group',source_rows.id,1,'queued',source_rows.created_by,NULL,
        'linked',source_rows.id,source_rows.fingerprint,
        pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to('group:' || source_rows.id::text,'UTF8')),'hex'),
        'group_avatar_audit',NULL,NULL,NULL,0,0,0,ARRAY[]::text[],pg_catalog.statement_timestamp(),NULL
      FROM source_rows ON CONFLICT DO NOTHING RETURNING target_id
    )
    SELECT (SELECT pg_catalog.count(*) FROM source_rows),
      (SELECT (pg_catalog.array_agg(source_rows.id ORDER BY source_rows.id DESC))[1] FROM source_rows),
      (SELECT pg_catalog.count(*) FROM inserted)
    INTO v_count,v_last_id,v_enqueued_count;
    v_next_kind := 'done';
  END IF;

  IF v_count < p_limit THEN
    IF v_next_kind = 'done' THEN
      UPDATE public.post_media_coverage_runs SET state='reconciling',cursor_kind='post',
        cursor_id='00000000-0000-0000-0000-000000000000',
        cursor_started=false,
        reconciling_at=pg_catalog.statement_timestamp(),
        population_fingerprint=pg_catalog.encode(pg_catalog.sha256(
          pg_catalog.convert_to(pg_catalog.jsonb_build_array(
            'population-v1',v_run.run_id,v_run.operation_id,v_run.generation,
            v_run.config_revision,v_run.storage_origin,v_run.origin_fingerprint,
            v_run.classifier_version
          )::text,'UTF8')),'hex'),
        target_count=target_count+v_enqueued_count,
        post_edit_count=0,group_review_count=0,group_avatar_count=0,audit_only_count=0,
        empty_count=0,external_only_count=0,covered_count=0,quarantined_count=0,
        source_absent_count=0,claimable_count=0,conflicting_count=0
      WHERE run_id=p_run_id;
    ELSE
      UPDATE public.post_media_coverage_runs SET cursor_kind=v_next_kind,
        cursor_id='00000000-0000-0000-0000-000000000000',
        cursor_started=false,
        target_count=target_count+v_enqueued_count
      WHERE run_id=p_run_id;
    END IF;
  ELSE
    UPDATE public.post_media_coverage_runs SET cursor_id=v_last_id,cursor_started=true,
      target_count=target_count+v_enqueued_count
    WHERE run_id=p_run_id;
  END IF;
  SELECT * INTO v_run FROM public.post_media_coverage_runs AS run_row WHERE run_row.run_id=p_run_id;
  RETURN pg_catalog.jsonb_build_object(
    'status','enqueued','applied',v_count > 0,'run_id',p_run_id,'state',v_run.state,
    'cursor_kind',v_run.cursor_kind,'cursor_id',v_run.cursor_id,
    'scanned',v_count,'enqueued',v_enqueued_count,
    'target_count',v_run.target_count
  );
END
$function$;

CREATE OR REPLACE FUNCTION public.seal_post_media_coverage_inventory_atomic(
  p_run_id uuid,
  p_limit integer
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
SET lock_timeout = '5s'
SET statement_timeout = '30s'
SET TimeZone = 'UTC'
AS $function$
DECLARE
  v_run public.post_media_coverage_runs%ROWTYPE;
  v_target public.post_media_coverage_targets%ROWTYPE;
  v_reconciled integer := 0;
  v_last_id uuid;
  v_next_kind text;
  v_population_fingerprint text;
  v_post_edit_count integer := 0;
  v_group_review_count integer := 0;
  v_group_avatar_count integer := 0;
  v_audit_only_count integer := 0;
  v_empty_count integer := 0;
  v_external_only_count integer := 0;
  v_covered_count integer := 0;
  v_quarantined_count integer := 0;
  v_source_absent_count integer := 0;
  v_claimable_count integer := 0;
  v_conflicting_count integer := 0;
BEGIN
  IF COALESCE((SELECT auth.role()), '') <> 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='service role required';
  END IF;
  IF p_run_id IS NULL OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='seal limit must be between 1 and 500';
  END IF;
  IF NOT pg_catalog.pg_try_advisory_xact_lock_shared(
    pg_catalog.hashtextextended('public-post-media-claims@1',0)
  ) OR NOT pg_catalog.pg_try_advisory_xact_lock_shared(
    pg_catalog.hashtextextended('public-post-media-coverage@1',0)
  ) THEN
    RAISE EXCEPTION USING ERRCODE='55P03', MESSAGE='post media coverage migration is active';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('post-media-coverage-run:' || p_run_id::text,0)
  );
  SELECT * INTO v_run FROM public.post_media_coverage_runs AS run_row
  WHERE run_row.run_id=p_run_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE='P0002', MESSAGE='post media coverage run not found';
  END IF;
  IF v_run.state='sealed' THEN
    RETURN pg_catalog.jsonb_build_object(
      'status','replayed','applied',false,'run_id',p_run_id,'state','sealed',
      'generation',v_run.generation,'config_revision',v_run.config_revision,
      'origin_fingerprint',v_run.origin_fingerprint,
      'classifier_version',v_run.classifier_version,
      'population_fingerprint',v_run.population_fingerprint,
      'snapshot_only',true,'authoritative_for_gc',false
    );
  END IF;
  IF v_run.state<>'reconciling' THEN
    RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='post media coverage enqueue is incomplete';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.post_media_coverage_targets AS target_row
    WHERE target_row.run_id=p_run_id
      AND target_row.queue_state IN ('queued','stale')
  ) THEN
    RETURN pg_catalog.jsonb_build_object(
      'status','work_remaining','applied',false,'run_id',p_run_id,
      'state','reconciling','snapshot_only',true
    );
  END IF;

  -- Sealing is a persistent keyset fold over immutable observed summaries. It
  -- never locks or scans a business, registry, Storage, or claim table. A seal
  -- attests this generation's historical observation snapshot, not live
  -- currentness; source changes are captured by a subsequent generation.
  v_population_fingerprint := v_run.population_fingerprint;
  FOR v_target IN
    SELECT target_row.*
    FROM public.post_media_coverage_targets AS target_row
    WHERE target_row.run_id=p_run_id
      AND target_row.target_kind=v_run.cursor_kind
      AND target_row.target_id >= CASE WHEN v_run.cursor_started THEN v_run.cursor_id
            ELSE '00000000-0000-0000-0000-000000000000'::uuid END
      AND (NOT v_run.cursor_started OR target_row.target_id>v_run.cursor_id)
    ORDER BY target_row.target_id
    LIMIT p_limit
  LOOP
    v_population_fingerprint := pg_catalog.encode(pg_catalog.sha256(
      pg_catalog.convert_to(
        v_population_fingerprint || ':' || pg_catalog.jsonb_build_array(
          'target-v1',v_target.target_kind,v_target.target_id,v_target.attempt,
          v_target.source_owner_id,v_target.source_revision,v_target.source_status,
          v_target.source_group_id,v_target.source_fingerprint,v_target.link_fingerprint,
          v_target.eligibility,v_target.coverage_state,v_target.claim_state,
          v_target.manifest_fingerprint,v_target.reference_count,v_target.managed_count,
          v_target.external_count,v_target.blockers,
          pg_catalog.date_part('epoch',v_target.observed_at)
        )::text,'UTF8'
      )
    ),'hex');
    v_reconciled := v_reconciled+1;
    v_last_id := v_target.target_id;
    v_post_edit_count := v_post_edit_count+(v_target.eligibility='post_edit')::integer;
    v_group_review_count := v_group_review_count+(v_target.eligibility='group_review')::integer;
    v_group_avatar_count := v_group_avatar_count+(v_target.eligibility='group_avatar_audit')::integer;
    v_audit_only_count := v_audit_only_count+(v_target.eligibility='audit_only')::integer;
    v_empty_count := v_empty_count+(v_target.coverage_state='empty')::integer;
    v_external_only_count := v_external_only_count+(v_target.coverage_state='external_only')::integer;
    v_covered_count := v_covered_count+(v_target.coverage_state='covered')::integer;
    v_quarantined_count := v_quarantined_count+(v_target.coverage_state='quarantined')::integer;
    v_source_absent_count := v_source_absent_count+(v_target.coverage_state='source_absent')::integer;
    v_claimable_count := v_claimable_count+(v_target.claim_state='claimable')::integer;
    v_conflicting_count := v_conflicting_count+(v_target.claim_state='conflicting')::integer;
  END LOOP;

  v_next_kind := CASE v_run.cursor_kind
    WHEN 'post' THEN 'group_application'
    WHEN 'group_application' THEN 'group'
    ELSE 'done'
  END;
  IF v_reconciled=p_limit THEN
    v_next_kind := v_run.cursor_kind;
  END IF;

  UPDATE public.post_media_coverage_runs AS run_row SET
    cursor_kind=CASE WHEN v_next_kind='done' THEN 'done' ELSE v_next_kind END,
    cursor_id=CASE
      WHEN v_next_kind='done' THEN 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid
      WHEN v_next_kind=v_run.cursor_kind THEN v_last_id
      ELSE '00000000-0000-0000-0000-000000000000'::uuid
    END,
    cursor_started=CASE WHEN v_next_kind=v_run.cursor_kind
      OR v_next_kind='done' THEN true ELSE false END,
    state=CASE WHEN v_next_kind='done' THEN 'sealed' ELSE 'reconciling' END,
    sealed_at=CASE WHEN v_next_kind='done'
      THEN pg_catalog.statement_timestamp() ELSE NULL END,
    population_fingerprint=v_population_fingerprint,
    post_edit_count=run_row.post_edit_count+v_post_edit_count,
    group_review_count=run_row.group_review_count+v_group_review_count,
    group_avatar_count=run_row.group_avatar_count+v_group_avatar_count,
    audit_only_count=run_row.audit_only_count+v_audit_only_count,
    empty_count=run_row.empty_count+v_empty_count,
    external_only_count=run_row.external_only_count+v_external_only_count,
    covered_count=run_row.covered_count+v_covered_count,
    quarantined_count=run_row.quarantined_count+v_quarantined_count,
    source_absent_count=run_row.source_absent_count+v_source_absent_count,
    claimable_count=run_row.claimable_count+v_claimable_count,
    conflicting_count=run_row.conflicting_count+v_conflicting_count
  WHERE run_row.run_id=p_run_id
  RETURNING * INTO v_run;

  RETURN pg_catalog.jsonb_build_object(
    'status',CASE WHEN v_run.state='sealed' THEN 'sealed' ELSE 'reconciling' END,
    'applied',true,'run_id',p_run_id,'state',v_run.state,
    'cursor_kind',v_run.cursor_kind,'cursor_id',v_run.cursor_id,
    'reconciled',v_reconciled,'generation',v_run.generation,
    'config_revision',v_run.config_revision,
    'origin_fingerprint',v_run.origin_fingerprint,
    'classifier_version',v_run.classifier_version,
    'population_fingerprint',v_run.population_fingerprint,
    'snapshot_only',true,'authoritative_for_gc',false
  );
END
$function$;

CREATE OR REPLACE FUNCTION public.read_post_media_coverage_gate_atomic(
  p_run_id uuid,
  p_scope text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
SET lock_timeout = '5s'
SET statement_timeout = '30s'
SET TimeZone = 'UTC'
AS $function$
DECLARE
  v_run record;
  v_scope_count integer;
  v_blocked_count integer;
  v_claimable_count integer;
  v_conflicting_count integer;
  v_quarantined_count integer;
  v_snapshot_inventory_complete boolean;
  v_snapshot_scope_complete boolean;
  v_observed_at_min timestamptz;
  v_observed_at_max timestamptz;
BEGIN
  IF COALESCE((SELECT auth.role()), '') <> 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='service role required';
  END IF;
  IF p_run_id IS NULL OR p_scope IS NULL
     OR p_scope NOT IN ('post_edit','group_review','group_avatar_audit','all')
  THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='invalid post media coverage gate scope';
  END IF;
  IF NOT pg_catalog.pg_try_advisory_xact_lock_shared(
    pg_catalog.hashtextextended('public-post-media-claims@1',0)
  ) OR NOT pg_catalog.pg_try_advisory_xact_lock_shared(
    pg_catalog.hashtextextended('public-post-media-coverage@1',0)
  ) THEN
    RAISE EXCEPTION USING ERRCODE='55P03', MESSAGE='post media coverage migration is active';
  END IF;
  SELECT * INTO v_run FROM public.post_media_coverage_runs AS run_row
  WHERE run_row.run_id=p_run_id FOR SHARE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'status','uninitialized','run_id',p_run_id,'scope',p_scope,
      'snapshot_only',true,'snapshot_inventory_complete',false,
      'snapshot_scope_complete',false,'cutover_ready',false,
      'authoritative_for_gc',false,
      'requires_new_generation_after_source_drain',true,
      'target_count',0,'blocked_count',0,
      'claimable_count',0,'conflicting_count',0,'quarantined_count',0,
      'observed_at_min',NULL,'observed_at_max',NULL
    );
  END IF;
  v_snapshot_inventory_complete := v_run.state='sealed';
  SELECT pg_catalog.count(*)::integer,
    pg_catalog.count(*) FILTER (WHERE target_row.queue_state<>'observed'
      OR target_row.coverage_state IN ('quarantined','source_absent')
      OR target_row.claim_state='conflicting')::integer,
    pg_catalog.count(*) FILTER (WHERE target_row.claim_state='claimable')::integer,
    pg_catalog.count(*) FILTER (WHERE target_row.claim_state='conflicting')::integer,
    pg_catalog.count(*) FILTER (WHERE target_row.coverage_state='quarantined')::integer,
    pg_catalog.min(target_row.observed_at),pg_catalog.max(target_row.observed_at)
  INTO v_scope_count,v_blocked_count,v_claimable_count,v_conflicting_count,
    v_quarantined_count,v_observed_at_min,v_observed_at_max
  FROM public.post_media_coverage_targets AS target_row
  WHERE target_row.run_id=p_run_id AND (
    p_scope='all'
    OR target_row.eligibility=p_scope
    OR (target_row.eligibility='source_absent' AND (
      (p_scope='post_edit' AND target_row.target_kind='post')
      OR (p_scope='group_review' AND target_row.target_kind='group_application')
      OR (p_scope='group_avatar_audit' AND target_row.target_kind='group')
    ))
  );
  v_snapshot_scope_complete := v_snapshot_inventory_complete AND v_blocked_count=0;
  RETURN pg_catalog.jsonb_build_object(
    'status',CASE WHEN v_snapshot_scope_complete THEN 'snapshot_complete'
      WHEN v_snapshot_inventory_complete THEN 'snapshot_blocked' ELSE 'snapshot_incomplete' END,
    'run_id',p_run_id,'generation',v_run.generation,'scope',p_scope,
    'config_revision',v_run.config_revision,'origin_fingerprint',v_run.origin_fingerprint,
    'classifier_version',v_run.classifier_version,
    'snapshot_only',true,'snapshot_inventory_complete',v_snapshot_inventory_complete,
    'snapshot_scope_complete',v_snapshot_scope_complete,'cutover_ready',false,
    'authoritative_for_gc',false,
    'requires_new_generation_after_source_drain',true,
    'target_count',v_scope_count,'blocked_count',v_blocked_count,
    'observed_at_min',v_observed_at_min,'observed_at_max',v_observed_at_max,
    'started_at',v_run.started_at,'reconciling_at',v_run.reconciling_at,
    'sealed_at',v_run.sealed_at,
    'population_fingerprint',v_run.population_fingerprint,
    'claimable_count',v_claimable_count,'conflicting_count',v_conflicting_count,
    'quarantined_count',v_quarantined_count
  );
END
$function$;

CREATE OR REPLACE FUNCTION public.observe_post_media_coverage_inventory_atomic(
  p_run_id uuid,
  p_limit integer
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
SET lock_timeout = '5s'
SET statement_timeout = '30s'
SET TimeZone = 'UTC'
AS $function$
DECLARE
  v_run record;
  v_candidate_count integer;
  v_observed_count integer;
  v_upload_id uuid;
  v_group_id uuid;
  v_locked_group_ids uuid[] := ARRAY[]::uuid[];
  v_object_name text;
BEGIN
  IF COALESCE((SELECT auth.role()), '') <> 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'service role required';
  END IF;
  IF p_run_id IS NULL OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 25 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'observe limit must be between 1 and 25';
  END IF;
  IF NOT pg_catalog.pg_try_advisory_xact_lock_shared(
    pg_catalog.hashtextextended('public-post-media-claims@1', 0)
  ) OR NOT pg_catalog.pg_try_advisory_xact_lock_shared(
    pg_catalog.hashtextextended('public-post-media-coverage@1', 0)
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '55P03', MESSAGE = 'post media coverage migration is active';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock_shared(
    pg_catalog.hashtextextended('post-media-coverage-run:' || p_run_id::text, 0)
  );
  SELECT * INTO v_run FROM public.post_media_coverage_runs AS run_row
  WHERE run_row.run_id = p_run_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'post media coverage run not found';
  END IF;
  IF v_run.state = 'sealed' THEN
    RETURN pg_catalog.jsonb_build_object(
      'status','replayed','applied',false,'run_id',p_run_id,'state','sealed','observed',0
    );
  END IF;

  CREATE TEMP TABLE IF NOT EXISTS post_media_coverage_batch_targets (
    target_kind text NOT NULL,
    target_id uuid NOT NULL,
    source_present boolean NOT NULL,
    PRIMARY KEY(target_kind,target_id)
  ) ON COMMIT DROP;
  IF NOT COALESCE((
    SELECT relation.relowner = pg_catalog.to_regrole('postgres')
       AND relation.relpersistence = 't'
       AND relation.relkind = 'r'
       AND relation.relnamespace = pg_catalog.pg_my_temp_schema()
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = pg_catalog.to_regclass('pg_temp.post_media_coverage_batch_targets')
  ), false) THEN
    RAISE EXCEPTION USING ERRCODE='42501',
      MESSAGE='unsafe post media coverage targets temp relation';
  END IF;
  TRUNCATE pg_temp.post_media_coverage_batch_targets;
  INSERT INTO pg_temp.post_media_coverage_batch_targets(
    target_kind,target_id,source_present
  )
  SELECT target_row.target_kind,target_row.target_id,false
  FROM public.post_media_coverage_targets AS target_row
  WHERE target_row.run_id=p_run_id AND target_row.queue_state IN ('queued','stale')
  ORDER BY target_row.queue_state,target_row.target_kind,target_row.target_id
  FOR UPDATE OF target_row SKIP LOCKED
  LIMIT p_limit;
  GET DIAGNOSTICS v_candidate_count = ROW_COUNT;
  IF v_candidate_count = 0 THEN
    SELECT run_row.observed_count INTO v_observed_count
    FROM public.post_media_coverage_runs AS run_row WHERE run_row.run_id=p_run_id;
    RETURN pg_catalog.jsonb_build_object(
      'status',CASE WHEN EXISTS (
        SELECT 1 FROM public.post_media_coverage_targets AS target_row
        WHERE target_row.run_id=p_run_id
          AND target_row.queue_state IN ('queued','stale')
      ) THEN 'busy' ELSE 'idle' END,
      'applied',false,'run_id',p_run_id,'state',v_run.state,
      'observed',0,'observed_count',v_observed_count
    );
  END IF;

  -- Lock the complete business-row batch before any object identity. A worker
  -- never takes an object lock for A and then waits for a business row for B.
  WITH locked_source AS MATERIALIZED (
    SELECT post_row.id,
      post_row.deleted_at IS NULL
        AND post_row.status='active'::public.post_status AS source_present
    FROM public.posts AS post_row
    JOIN pg_temp.post_media_coverage_batch_targets AS batch
      ON batch.target_kind='post' AND batch.target_id=post_row.id
    ORDER BY post_row.id
    FOR SHARE OF post_row NOWAIT
  )
  UPDATE pg_temp.post_media_coverage_batch_targets AS batch
  SET source_present=locked_source.source_present
  FROM locked_source
  WHERE batch.target_kind='post' AND batch.target_id=locked_source.id;
  WITH locked_source AS MATERIALIZED (
    SELECT app_row.id
    FROM public.group_applications AS app_row
    JOIN pg_temp.post_media_coverage_batch_targets AS batch
      ON batch.target_kind='group_application' AND batch.target_id=app_row.id
    ORDER BY app_row.id
    FOR SHARE OF app_row NOWAIT
  )
  UPDATE pg_temp.post_media_coverage_batch_targets AS batch
  SET source_present=true
  FROM locked_source
  WHERE batch.target_kind='group_application' AND batch.target_id=locked_source.id;
  FOR v_group_id IN
    SELECT bounded_group.group_id FROM (
      SELECT batch.target_id AS group_id
      FROM pg_temp.post_media_coverage_batch_targets AS batch
      WHERE batch.target_kind='group'
      UNION
      SELECT app_row.group_id
      FROM pg_temp.post_media_coverage_batch_targets AS batch
      JOIN public.group_applications AS app_row
        ON batch.target_kind='group_application' AND batch.target_id=app_row.id
      WHERE batch.source_present AND app_row.group_id IS NOT NULL
    ) AS bounded_group
    ORDER BY bounded_group.group_id
  LOOP
    PERFORM group_row.id FROM public.groups AS group_row
    WHERE group_row.id=v_group_id FOR SHARE OF group_row NOWAIT;
    IF FOUND THEN
      v_locked_group_ids := pg_catalog.array_append(v_locked_group_ids,v_group_id);
      UPDATE pg_temp.post_media_coverage_batch_targets AS batch
      SET source_present=true
      WHERE batch.target_kind='group' AND batch.target_id=v_group_id;
    END IF;
  END LOOP;

  -- Refresh the source snapshot under the batch locks. A change increments the
  -- evidence attempt, so prior evidence remains immutable and attributable.
  WITH current_source AS (
    SELECT post_row.id,post_row.author_id,post_row.content_version,
      CASE WHEN CASE
        WHEN pg_catalog.pg_column_compression(post_row.images) IS NOT NULL THEN true
        WHEN COALESCE(pg_catalog.pg_column_size(post_row.images),0)>262144 THEN true
        WHEN pg_catalog.octet_length(COALESCE(post_row.content,''))>262144
          OR COALESCE(pg_catalog.cardinality(post_row.images),0)>64 THEN true
        ELSE COALESCE((SELECT pg_catalog.sum(pg_catalog.octet_length(element.value))
          FROM pg_catalog.unnest(COALESCE(post_row.images,ARRAY[]::text[]))
            AS element(value)),0)>262144 END
      THEN pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
        pg_catalog.jsonb_build_array('oversized-post-v2',post_row.author_id,
          post_row.content_version,
          pg_catalog.octet_length(COALESCE(post_row.content,'')),
          COALESCE(pg_catalog.pg_column_compression(post_row.images),'uncompressed'),
          COALESCE(pg_catalog.pg_column_size(post_row.images),0),
          post_row.deleted_at,post_row.status)::text,'UTF8')),'hex')
      ELSE pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
        pg_catalog.jsonb_build_array(post_row.author_id,post_row.content_version,
          post_row.content,post_row.images,post_row.deleted_at,post_row.status)::text,'UTF8')),'hex')
      END AS fingerprint
    FROM public.posts AS post_row
    JOIN pg_temp.post_media_coverage_batch_targets AS batch
      ON batch.target_kind='post' AND batch.target_id=post_row.id
     AND batch.source_present
    WHERE post_row.deleted_at IS NULL
      AND post_row.status = 'active'::public.post_status
  )
  UPDATE public.post_media_coverage_targets AS target_row SET
    attempt=target_row.attempt + CASE WHEN target_row.source_fingerprint IS DISTINCT FROM current_source.fingerprint THEN 1 ELSE 0 END,
    source_owner_id=current_source.author_id,source_revision=current_source.content_version,
    source_status='active',source_group_id=NULL,source_fingerprint=current_source.fingerprint,
    link_fingerprint=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to('post:' || current_source.id::text,'UTF8')),'hex'),
    eligibility='post_edit',coverage_state=NULL,claim_state=NULL,manifest_fingerprint=NULL,
    reference_count=0,managed_count=0,external_count=0,blockers=ARRAY[]::text[],observed_at=NULL
  FROM current_source
  WHERE target_row.run_id=p_run_id AND target_row.target_kind='post' AND target_row.target_id=current_source.id;

  WITH current_source AS (
    SELECT app_row.id,app_row.applicant_id,app_row.status,app_row.group_id,
      CASE WHEN pg_catalog.octet_length(app_row.status)>256
        THEN 'oversized-status:' || pg_catalog.octet_length(app_row.status)::text
        ELSE app_row.status END AS snapshot_status,
      pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(CASE
        WHEN pg_catalog.octet_length(app_row.status)>256
        THEN pg_catalog.jsonb_build_array('oversized-application-status-v1',app_row.applicant_id,
          pg_catalog.octet_length(app_row.status),
          pg_catalog.octet_length(COALESCE(app_row.avatar_url,'')),app_row.group_id)
        WHEN pg_catalog.octet_length(COALESCE(app_row.avatar_url,''))>262144
        THEN pg_catalog.jsonb_build_array('oversized-application-v1',app_row.applicant_id,
          pg_catalog.octet_length(COALESCE(app_row.avatar_url,'')),app_row.status,app_row.group_id)
        ELSE pg_catalog.jsonb_build_array(app_row.applicant_id,app_row.avatar_url,
          app_row.status,app_row.group_id) END::text,'UTF8')),'hex') AS fingerprint,
      pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(CASE
        WHEN pg_catalog.octet_length(app_row.status)>256
        THEN pg_catalog.jsonb_build_array('oversized-application-link-status-v1',
          pg_catalog.octet_length(app_row.status),app_row.group_id,linked_group.id,
          linked_group.created_by,
          pg_catalog.octet_length(COALESCE(linked_group.avatar_url,'')))
        WHEN pg_catalog.octet_length(COALESCE(linked_group.avatar_url,''))>262144
        THEN pg_catalog.jsonb_build_array('oversized-application-link-v1',app_row.status,
          app_row.group_id,linked_group.id,linked_group.created_by,
          pg_catalog.octet_length(COALESCE(linked_group.avatar_url,'')))
        ELSE pg_catalog.jsonb_build_array('application-link-v1',app_row.status,
          app_row.group_id,linked_group.id,linked_group.created_by,
          linked_group.avatar_url) END::text,'UTF8')),'hex') AS link_fingerprint
    FROM public.group_applications AS app_row
    JOIN pg_temp.post_media_coverage_batch_targets AS batch
      ON batch.target_kind='group_application' AND batch.target_id=app_row.id
     AND batch.source_present
    LEFT JOIN public.groups AS linked_group
      ON linked_group.id=app_row.group_id
     AND linked_group.id=ANY(v_locked_group_ids)
  )
  UPDATE public.post_media_coverage_targets AS target_row SET
    attempt=target_row.attempt + CASE
      WHEN target_row.source_fingerprint IS DISTINCT FROM current_source.fingerprint
        OR target_row.link_fingerprint IS DISTINCT FROM current_source.link_fingerprint
      THEN 1 ELSE 0 END,
    source_owner_id=current_source.applicant_id,source_revision=NULL,
    source_status=current_source.snapshot_status,source_group_id=current_source.group_id,
    source_fingerprint=current_source.fingerprint,
    link_fingerprint=current_source.link_fingerprint,
    eligibility=CASE WHEN current_source.snapshot_status='pending'
      THEN 'group_review' ELSE 'audit_only' END,
    coverage_state=NULL,claim_state=NULL,manifest_fingerprint=NULL,
    reference_count=0,managed_count=0,external_count=0,blockers=ARRAY[]::text[],observed_at=NULL
  FROM current_source
  WHERE target_row.run_id=p_run_id AND target_row.target_kind='group_application'
    AND target_row.target_id=current_source.id;

  WITH current_source AS (
    SELECT group_row.id,group_row.created_by,
      pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(CASE
        WHEN pg_catalog.octet_length(COALESCE(group_row.avatar_url,''))>262144
        THEN pg_catalog.jsonb_build_array('oversized-group-v1',group_row.created_by,
          pg_catalog.octet_length(COALESCE(group_row.avatar_url,'')))
        ELSE pg_catalog.jsonb_build_array(group_row.created_by,group_row.avatar_url)
        END::text,'UTF8')),'hex') AS fingerprint
    FROM public.groups AS group_row
    JOIN pg_temp.post_media_coverage_batch_targets AS batch
      ON batch.target_kind='group' AND batch.target_id=group_row.id
     AND batch.source_present
  )
  UPDATE public.post_media_coverage_targets AS target_row SET
    attempt=target_row.attempt + CASE WHEN target_row.source_fingerprint IS DISTINCT FROM current_source.fingerprint THEN 1 ELSE 0 END,
    source_owner_id=current_source.created_by,source_revision=NULL,source_status='linked',
    source_group_id=current_source.id,source_fingerprint=current_source.fingerprint,
    link_fingerprint=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to('group:' || current_source.id::text,'UTF8')),'hex'),
    eligibility='group_avatar_audit',coverage_state=NULL,claim_state=NULL,manifest_fingerprint=NULL,
    reference_count=0,managed_count=0,external_count=0,blockers=ARRAY[]::text[],observed_at=NULL
  FROM current_source
  WHERE target_row.run_id=p_run_id AND target_row.target_kind='group' AND target_row.target_id=current_source.id;

  UPDATE public.post_media_coverage_targets AS target_row SET
    attempt=target_row.attempt + CASE
      WHEN target_row.eligibility='source_absent'
       AND target_row.source_fingerprint=pg_catalog.encode(pg_catalog.sha256(
         pg_catalog.convert_to('source_absent','UTF8')),'hex') THEN 0 ELSE 1 END,
    queue_state='stale',source_owner_id=NULL,
    source_revision=NULL,source_status=NULL,source_group_id=NULL,
    source_fingerprint=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to('source_absent','UTF8')),'hex'),
    link_fingerprint=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
      target_row.target_kind || ':' || target_row.target_id::text || ':absent','UTF8')),'hex'),
    eligibility='source_absent',coverage_state=NULL,claim_state=NULL,manifest_fingerprint=NULL,
    reference_count=0,managed_count=0,external_count=0,blockers=ARRAY[]::text[],observed_at=NULL
  FROM pg_temp.post_media_coverage_batch_targets AS batch
  WHERE target_row.run_id=p_run_id AND target_row.target_kind=batch.target_kind
    AND target_row.target_id=batch.target_id
    AND NOT batch.source_present;

  -- Persist the immutable per-attempt source/link snapshot before any
  -- reference evidence can satisfy its foreign key. A failed observation
  -- rolls this insert back; a completed historical attempt is never updated.
  INSERT INTO public.post_media_coverage_attempts(
    run_id,target_kind,target_id,attempt,source_owner_id,source_revision,
    source_status,source_group_id,source_fingerprint,link_fingerprint,eligibility,
    coverage_state,claim_state,manifest_fingerprint,reference_count,managed_count,
    external_count,blockers,observed_at
  )
  SELECT target_row.run_id,target_row.target_kind,target_row.target_id,target_row.attempt,
    target_row.source_owner_id,target_row.source_revision,target_row.source_status,
    target_row.source_group_id,target_row.source_fingerprint,target_row.link_fingerprint,
    target_row.eligibility,NULL,NULL,NULL,0,0,0,ARRAY[]::text[],NULL
  FROM public.post_media_coverage_targets AS target_row
  JOIN pg_temp.post_media_coverage_batch_targets AS batch
    ON batch.target_kind=target_row.target_kind AND batch.target_id=target_row.target_id
  WHERE target_row.run_id=p_run_id;

  CREATE TEMP TABLE IF NOT EXISTS post_media_coverage_batch_blockers (
    target_kind text NOT NULL,target_id uuid NOT NULL,blocker text NOT NULL,
    PRIMARY KEY(target_kind,target_id,blocker)
  ) ON COMMIT DROP;
  IF NOT COALESCE((
    SELECT relation.relowner = pg_catalog.to_regrole('postgres')
       AND relation.relpersistence = 't'
       AND relation.relkind = 'r'
       AND relation.relnamespace = pg_catalog.pg_my_temp_schema()
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = pg_catalog.to_regclass('pg_temp.post_media_coverage_batch_blockers')
  ), false) THEN
    RAISE EXCEPTION USING ERRCODE='42501',
      MESSAGE='unsafe post media coverage blockers temp relation';
  END IF;
  TRUNCATE pg_temp.post_media_coverage_batch_blockers;
  INSERT INTO pg_temp.post_media_coverage_batch_blockers
  SELECT 'post',post_row.id,'source_reference_budget_exceeded'
  FROM public.posts AS post_row
  JOIN pg_temp.post_media_coverage_batch_targets AS batch
    ON batch.target_kind='post' AND batch.target_id=post_row.id
   AND batch.source_present
  WHERE post_row.deleted_at IS NULL
    AND post_row.status='active'::public.post_status
    AND CASE
      WHEN pg_catalog.pg_column_compression(post_row.images) IS NOT NULL THEN true
      WHEN COALESCE(pg_catalog.pg_column_size(post_row.images),0)>262144 THEN true
      WHEN pg_catalog.octet_length(COALESCE(post_row.content,''))>262144 THEN true
      WHEN COALESCE(pg_catalog.cardinality(post_row.images),0)>64 THEN false
      ELSE COALESCE((SELECT pg_catalog.sum(pg_catalog.octet_length(element.value))
        FROM pg_catalog.unnest(COALESCE(post_row.images,ARRAY[]::text[]))
          AS element(value)),0)>262144 END
  UNION ALL
  SELECT 'post',post_row.id,'post_images_shape_unsupported'
  FROM public.posts AS post_row
  JOIN pg_temp.post_media_coverage_batch_targets AS batch
    ON batch.target_kind='post' AND batch.target_id=post_row.id
   AND batch.source_present
  WHERE post_row.deleted_at IS NULL
    AND post_row.status='active'::public.post_status
    AND CASE
      WHEN pg_catalog.pg_column_compression(post_row.images) IS NOT NULL THEN false
      WHEN COALESCE(pg_catalog.pg_column_size(post_row.images),0)>262144 THEN false
      WHEN pg_catalog.array_ndims(post_row.images)>1 THEN true
      ELSE EXISTS (SELECT 1
        FROM pg_catalog.unnest(COALESCE(post_row.images,ARRAY[]::text[])) AS element(value)
        WHERE element.value IS NULL)
    END
  UNION ALL
  SELECT 'post',post_row.id,'reference_limit_exceeded'
  FROM public.posts AS post_row
  JOIN pg_temp.post_media_coverage_batch_targets AS batch
    ON batch.target_kind='post' AND batch.target_id=post_row.id
   AND batch.source_present
  WHERE post_row.deleted_at IS NULL
    AND post_row.status='active'::public.post_status
    AND CASE
      WHEN pg_catalog.pg_column_compression(post_row.images) IS NOT NULL THEN false
      WHEN COALESCE(pg_catalog.pg_column_size(post_row.images),0)>262144 THEN false
      ELSE COALESCE(pg_catalog.cardinality(post_row.images),0)>64
    END
  UNION ALL
  SELECT 'group_application',app_row.id,'source_reference_budget_exceeded'
  FROM public.group_applications AS app_row
  JOIN pg_temp.post_media_coverage_batch_targets AS batch
    ON batch.target_kind='group_application' AND batch.target_id=app_row.id
   AND batch.source_present
  LEFT JOIN public.groups AS linked_group
    ON linked_group.id=app_row.group_id
   AND linked_group.id=ANY(v_locked_group_ids)
  WHERE pg_catalog.octet_length(app_row.status)>256
     OR pg_catalog.octet_length(COALESCE(app_row.avatar_url,''))>262144
     OR pg_catalog.octet_length(COALESCE(linked_group.avatar_url,''))>262144
  UNION ALL
  SELECT 'group',group_row.id,'source_reference_budget_exceeded'
  FROM public.groups AS group_row
  JOIN pg_temp.post_media_coverage_batch_targets AS batch
    ON batch.target_kind='group' AND batch.target_id=group_row.id
   AND batch.source_present
  WHERE pg_catalog.octet_length(COALESCE(group_row.avatar_url,''))>262144
  ON CONFLICT DO NOTHING;

  CREATE TEMP TABLE IF NOT EXISTS post_media_coverage_batch_references (
    target_kind text NOT NULL,target_id uuid NOT NULL,reference_kind text NOT NULL,
    reference_key text NOT NULL,raw_reference text NOT NULL,
    source_mask integer NOT NULL,occurrences integer NOT NULL,
    classification text,object_name text,classifier_finding text,
    PRIMARY KEY(target_kind,target_id,reference_key)
  ) ON COMMIT DROP;
  IF NOT COALESCE((
    SELECT relation.relowner = pg_catalog.to_regrole('postgres')
       AND relation.relpersistence = 't'
       AND relation.relkind = 'r'
       AND relation.relnamespace = pg_catalog.pg_my_temp_schema()
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = pg_catalog.to_regclass('pg_temp.post_media_coverage_batch_references')
  ), false) THEN
    RAISE EXCEPTION USING ERRCODE='42501',
      MESSAGE='unsafe post media coverage references temp relation';
  END IF;
  TRUNCATE pg_temp.post_media_coverage_batch_references;

  INSERT INTO pg_temp.post_media_coverage_batch_references(
    target_kind,target_id,reference_kind,reference_key,raw_reference,source_mask,occurrences
  )
  WITH raw_reference AS (
    SELECT 'post'::text AS target_kind,post_row.id AS target_id,
      CASE WHEN pg_catalog.lower(image_ref.value) ~ '\.(mp4|mov|webm|mkv|avi)(?:[?#].*)?$'
        THEN 'post_video' ELSE 'post_image' END AS reference_kind,
      image_ref.value AS raw_reference,1 AS source_mask
    FROM public.posts AS post_row
    JOIN pg_temp.post_media_coverage_batch_targets AS batch
      ON batch.target_kind='post' AND batch.target_id=post_row.id
     AND batch.source_present
    CROSS JOIN LATERAL (
      SELECT image_element.value
      FROM pg_catalog.unnest(CASE
        WHEN pg_catalog.pg_column_compression(post_row.images) IS NOT NULL
          OR COALESCE(pg_catalog.pg_column_size(post_row.images),0)>262144
          OR pg_catalog.octet_length(COALESCE(post_row.content,''))>262144
        THEN ARRAY[]::text[]
        WHEN pg_catalog.array_ndims(post_row.images)>1
          OR EXISTS (SELECT 1
            FROM pg_catalog.unnest(COALESCE(post_row.images,ARRAY[]::text[])) AS element(value)
            WHERE element.value IS NULL)
        THEN ARRAY[]::text[]
        ELSE COALESCE(post_row.images,ARRAY[]::text[])
      END)
        WITH ORDINALITY AS image_element(value,ordinal)
      ORDER BY image_element.ordinal
      LIMIT 65
    ) AS image_ref
    WHERE post_row.deleted_at IS NULL
      AND post_row.status = 'active'::public.post_status
      AND CASE
        WHEN pg_catalog.pg_column_compression(post_row.images) IS NOT NULL THEN false
        WHEN COALESCE(pg_catalog.pg_column_size(post_row.images),0)>262144 THEN false
        WHEN pg_catalog.octet_length(COALESCE(post_row.content,''))>262144 THEN false
        WHEN pg_catalog.array_ndims(post_row.images)>1 THEN false
        WHEN EXISTS (SELECT 1
          FROM pg_catalog.unnest(COALESCE(post_row.images,ARRAY[]::text[])) AS element(value)
          WHERE element.value IS NULL) THEN false
        WHEN COALESCE(pg_catalog.cardinality(post_row.images),0)>64 THEN false
        ELSE COALESCE((SELECT pg_catalog.sum(pg_catalog.octet_length(element.value))
          FROM pg_catalog.unnest(COALESCE(post_row.images,ARRAY[]::text[]))
            AS element(value)),0)<=262144 END
      AND image_ref.value IS NOT NULL
    UNION ALL
    SELECT 'post',post_row.id,
      CASE WHEN pg_catalog.lower(url_match.raw_reference) ~ '\.(mp4|mov|webm|mkv|avi)(?:[?#].*)?$'
        THEN 'post_video' ELSE 'post_image' END,
      url_match.raw_reference,2
    FROM public.posts AS post_row
    JOIN pg_temp.post_media_coverage_batch_targets AS batch
      ON batch.target_kind='post' AND batch.target_id=post_row.id
     AND batch.source_present
    CROSS JOIN LATERAL (
      SELECT CASE
        WHEN pg_catalog.pg_column_compression(post_row.images) IS NOT NULL THEN ''::text
        WHEN COALESCE(pg_catalog.pg_column_size(post_row.images),0)>262144 THEN ''::text
        WHEN pg_catalog.octet_length(COALESCE(post_row.content,''))>262144 THEN ''::text
        WHEN COALESCE(pg_catalog.cardinality(post_row.images),0)>64 THEN ''::text
        WHEN COALESCE((SELECT pg_catalog.sum(pg_catalog.octet_length(element.value))
          FROM pg_catalog.unnest(COALESCE(post_row.images,ARRAY[]::text[]))
            AS element(value)),0)>262144 THEN ''::text
        ELSE COALESCE(post_row.content,'')
      END AS content
    ) AS bounded_source
    CROSS JOIN LATERAL (
      SELECT pg_catalog.regexp_replace(
        bounded_source.content,
        U&'[\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]',
        ' ','g'
      ) AS content
    ) AS normalized_source
    CROSS JOIN LATERAL (
      SELECT candidate.raw_reference
      FROM (
        SELECT image_token.value[2] AS raw_reference
        FROM pg_catalog.regexp_matches(
          bounded_source.content,
          $image$!\[([^\]\r\n]*)\]\(([^)\r\n]+)\)$image$,'g'
        ) AS image_token(value)
        UNION ALL
        SELECT image_raw.value[1]
        FROM pg_catalog.regexp_matches(
          bounded_source.content,
          $image$!\[([^\]\r\n]*)\]\(([^)\r\n]+)\)$image$,'g'
        ) AS image_token(value)
        CROSS JOIN LATERAL pg_catalog.regexp_matches(
          pg_catalog.regexp_replace(
            image_token.value[2],
            U&'[\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]',
            ' ','g'
          ),
          $raw$(https?://[^[:space:]<>"{}|\\^`\[\]]+)$raw$,'gi'
        ) AS image_raw(value)
        WHERE image_raw.value[1] IS DISTINCT FROM image_token.value[2]
        UNION ALL
        SELECT link_token.value[2]
        FROM pg_catalog.regexp_matches(
          bounded_source.content,
          $link$(?<!!)\[([^\]\r\n]*)\]\(([^)\r\n]+)\)$link$,'g'
        ) AS link_token(value)
        UNION ALL
        SELECT link_destination_raw.value[1]
        FROM pg_catalog.regexp_matches(
          bounded_source.content,
          $link$(?<!!)\[([^\]\r\n]*)\]\(([^)\r\n]+)\)$link$,'g'
        ) AS link_token(value)
        CROSS JOIN LATERAL pg_catalog.regexp_matches(
          pg_catalog.regexp_replace(
            link_token.value[2],
            U&'[\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]',
            ' ','g'
          ),
          $raw$(https?://[^[:space:]<>"{}|\\^`\[\]]+)$raw$,'gi'
        ) AS link_destination_raw(value)
        WHERE link_destination_raw.value[1] IS DISTINCT FROM link_token.value[2]
        UNION ALL
        SELECT link_label_raw.value[1]
        FROM pg_catalog.regexp_matches(
          bounded_source.content,
          $link$(?<!!)\[([^\]\r\n]*)\]\(([^)\r\n]+)\)$link$,'g'
        ) AS link_token(value)
        CROSS JOIN LATERAL pg_catalog.regexp_matches(
          pg_catalog.regexp_replace(
            link_token.value[1],
            U&'[\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]',
            ' ','g'
          ),
          $raw$(https?://[^[:space:]<>"{}|\\^`\[\]]+)$raw$,'gi'
        ) AS link_label_raw(value)
        UNION ALL
        SELECT raw_token.value[1]
        FROM pg_catalog.regexp_matches(
          pg_catalog.regexp_replace(
            normalized_source.content,
            $markdown$!?\[[^\]\r\n]*\]\([^)\r\n]+\)$markdown$,' ','g'
          ),
          $raw$(https?://[^[:space:]<>"{}|\\^`\[\]]+)$raw$,'gi'
        ) AS raw_token(value)
      ) AS candidate
      WHERE candidate.raw_reference IS NOT NULL
      LIMIT 65
    ) AS url_match
    WHERE post_row.deleted_at IS NULL
      AND post_row.status = 'active'::public.post_status
      AND bounded_source.content <> ''
    UNION ALL
    SELECT 'group_application',app_row.id,'group_avatar',app_row.avatar_url,4
    FROM public.group_applications AS app_row
    JOIN pg_temp.post_media_coverage_batch_targets AS batch
      ON batch.target_kind='group_application' AND batch.target_id=app_row.id
     AND batch.source_present
    WHERE CASE
      WHEN app_row.avatar_url IS NULL THEN false
      WHEN pg_catalog.octet_length(app_row.avatar_url)>262144 THEN false
      ELSE app_row.avatar_url <> ''
    END
    UNION ALL
    SELECT 'group',group_row.id,'group_avatar',group_row.avatar_url,4
    FROM public.groups AS group_row
    JOIN pg_temp.post_media_coverage_batch_targets AS batch
      ON batch.target_kind='group' AND batch.target_id=group_row.id
     AND batch.source_present
    WHERE CASE
      WHEN group_row.avatar_url IS NULL THEN false
      WHEN pg_catalog.octet_length(group_row.avatar_url)>262144 THEN false
      ELSE group_row.avatar_url <> ''
    END
  ), aggregated AS (
    SELECT raw_reference.target_kind,raw_reference.target_id,raw_reference.reference_kind,
      raw_reference.raw_reference,pg_catalog.bit_or(raw_reference.source_mask) AS source_mask,
      pg_catalog.count(*)::integer AS occurrences
    FROM raw_reference
    GROUP BY raw_reference.target_kind,raw_reference.target_id,
      raw_reference.reference_kind,raw_reference.raw_reference
  ), bounded AS (
    SELECT aggregated.*,
      pg_catalog.row_number() OVER (
        PARTITION BY aggregated.target_kind,aggregated.target_id
        ORDER BY aggregated.reference_kind,aggregated.raw_reference COLLATE "C"
      ) AS reference_ordinal
    FROM aggregated
  )
  SELECT bounded.target_kind,bounded.target_id,bounded.reference_kind,
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
      bounded.reference_kind || ':' || bounded.raw_reference,'UTF8')),'hex'),
    bounded.raw_reference,bounded.source_mask,bounded.occurrences
  FROM bounded WHERE bounded.reference_ordinal<=65;

  UPDATE pg_temp.post_media_coverage_batch_references AS reference_row SET
    classification=public.classify_post_media_reference_lexical_internal(
      reference_row.raw_reference,target_row.source_owner_id,
      reference_row.reference_kind,v_run.storage_origin
    )->>'classification',
    object_name=public.classify_post_media_reference_lexical_internal(
      reference_row.raw_reference,target_row.source_owner_id,
      reference_row.reference_kind,v_run.storage_origin
    )->>'object_name',
    classifier_finding=public.classify_post_media_reference_lexical_internal(
      reference_row.raw_reference,target_row.source_owner_id,
      reference_row.reference_kind,v_run.storage_origin
    )->>'finding'
  FROM public.post_media_coverage_targets AS target_row
  WHERE target_row.run_id=p_run_id AND target_row.target_kind=reference_row.target_kind
    AND target_row.target_id=reference_row.target_id
    AND target_row.eligibility <> 'source_absent';

  -- Immutable runtime lock order after business rows: all known upload ids,
  -- all object identities in C collation, registry rows, Storage rows, claims.
  FOR v_upload_id IN
    SELECT DISTINCT upload_row.upload_id
    FROM public.post_media_uploads AS upload_row
    JOIN pg_temp.post_media_coverage_batch_references AS reference_row
      ON reference_row.object_name=upload_row.object_name
    ORDER BY upload_row.upload_id
  LOOP
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('post-media-upload-id:' || v_upload_id::text,0)
    );
  END LOOP;
  FOR v_object_name IN
    SELECT DISTINCT reference_row.object_name COLLATE "C" AS object_name
    FROM pg_temp.post_media_coverage_batch_references AS reference_row
    WHERE reference_row.object_name IS NOT NULL
    ORDER BY reference_row.object_name COLLATE "C"
  LOOP
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('post-media-object:' || v_object_name,0)
    );
  END LOOP;
  PERFORM upload_row.upload_id
  FROM public.post_media_uploads AS upload_row
  JOIN pg_temp.post_media_coverage_batch_references AS reference_row
    ON reference_row.object_name=upload_row.object_name
  ORDER BY upload_row.upload_id FOR SHARE OF upload_row;
  PERFORM storage_row.name
  FROM storage.objects AS storage_row
  JOIN pg_temp.post_media_coverage_batch_references AS reference_row
    ON reference_row.object_name=storage_row.name
  WHERE storage_row.bucket_id='posts'
  ORDER BY storage_row.name COLLATE "C" FOR SHARE OF storage_row;
  PERFORM claim_row.upload_id
  FROM public.post_media_claims AS claim_row
  JOIN public.post_media_uploads AS upload_row ON upload_row.upload_id=claim_row.upload_id
  JOIN pg_temp.post_media_coverage_batch_references AS reference_row
    ON reference_row.object_name=upload_row.object_name
  ORDER BY claim_row.upload_id,claim_row.target_kind,claim_row.target_id
  FOR SHARE OF claim_row;

  INSERT INTO public.post_media_coverage_references(
    run_id,target_kind,target_id,attempt,reference_key,source_mask,occurrences,
    raw_sha256,raw_length,classification,expected_reference_kind,object_name,
    upload_id,registry_state,storage_state,claim_state,finding,observed_at
  )
  SELECT p_run_id,reference_row.target_kind,reference_row.target_id,target_row.attempt,
    reference_row.reference_key,
    reference_row.source_mask,reference_row.occurrences,
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(reference_row.raw_reference,'UTF8')),'hex'),
    pg_catalog.octet_length(reference_row.raw_reference),reference_row.classification,
    reference_row.reference_kind,reference_row.object_name,upload_row.upload_id,
    CASE
      WHEN reference_row.classification <> 'canonical_managed' THEN 'not_applicable'
      WHEN upload_row.upload_id IS NULL THEN 'unregistered'
      WHEN upload_row.gc_admitted_at IS NOT NULL THEN 'gc_admitted'
      WHEN upload_row.status <> 'uploaded' THEN 'reserved'
      WHEN upload_row.owner_id IS DISTINCT FROM target_row.source_owner_id THEN 'wrong_owner'
      WHEN (reference_row.reference_kind='post_image' AND upload_row.purpose NOT IN ('post_image','legacy_image'))
        OR (reference_row.reference_kind='post_video' AND upload_row.purpose <> 'post_video')
        OR (reference_row.reference_kind='group_avatar' AND upload_row.purpose NOT IN ('group_avatar','legacy_image'))
        THEN 'wrong_purpose'
      ELSE 'uploaded'
    END,
    CASE WHEN reference_row.classification <> 'canonical_managed' THEN 'not_applicable'
      WHEN storage_row.name IS NULL THEN 'missing' ELSE 'present' END,
    CASE WHEN reference_row.classification <> 'canonical_managed' THEN 'not_applicable'
      WHEN claim_row.upload_id IS NULL THEN 'missing'
      WHEN claim_row.reference_kind IS DISTINCT FROM reference_row.reference_kind THEN 'conflicting'
      ELSE 'matched' END,
    CASE
      WHEN reference_row.classification <> 'canonical_managed' THEN reference_row.classifier_finding
      WHEN upload_row.upload_id IS NULL THEN 'unregistered_object'
      WHEN upload_row.gc_admitted_at IS NOT NULL THEN 'gc_already_admitted'
      WHEN upload_row.status <> 'uploaded' THEN 'upload_not_finalized'
      WHEN upload_row.owner_id IS DISTINCT FROM target_row.source_owner_id THEN 'registry_owner_mismatch'
      WHEN (reference_row.reference_kind='post_image' AND upload_row.purpose NOT IN ('post_image','legacy_image'))
        OR (reference_row.reference_kind='post_video' AND upload_row.purpose <> 'post_video')
        OR (reference_row.reference_kind='group_avatar' AND upload_row.purpose NOT IN ('group_avatar','legacy_image'))
        THEN 'registry_purpose_mismatch'
      WHEN storage_row.name IS NULL THEN 'storage_object_missing'
      WHEN claim_row.upload_id IS NULL THEN 'claim_missing'
      WHEN claim_row.reference_kind IS DISTINCT FROM reference_row.reference_kind THEN 'claim_kind_conflict'
      ELSE 'covered_and_claimed'
    END,
    pg_catalog.statement_timestamp()
  FROM pg_temp.post_media_coverage_batch_references AS reference_row
  JOIN public.post_media_coverage_targets AS target_row
    ON target_row.run_id=p_run_id AND target_row.target_kind=reference_row.target_kind
   AND target_row.target_id=reference_row.target_id
  LEFT JOIN public.post_media_uploads AS upload_row ON upload_row.object_name=reference_row.object_name
  LEFT JOIN storage.objects AS storage_row
    ON storage_row.bucket_id='posts' AND storage_row.name=reference_row.object_name
  LEFT JOIN public.post_media_claims AS claim_row
    ON claim_row.upload_id=upload_row.upload_id
   AND claim_row.target_kind=reference_row.target_kind
   AND claim_row.target_id=reference_row.target_id
  ON CONFLICT (run_id,target_kind,target_id,attempt,reference_key) DO NOTHING;
  INSERT INTO pg_temp.post_media_coverage_batch_blockers
  SELECT evidence.target_kind,evidence.target_id,evidence.blocker
  FROM (
    SELECT reference_row.target_kind,reference_row.target_id,
      CASE
        WHEN reference_row.classification='malformed_or_ambiguous' THEN reference_row.finding
        WHEN reference_row.classification='canonical_managed' AND reference_row.registry_state<>'uploaded' THEN reference_row.finding
        WHEN reference_row.classification='canonical_managed' AND reference_row.storage_state<>'present' THEN reference_row.finding
        WHEN reference_row.classification='canonical_managed' AND reference_row.claim_state='conflicting' THEN reference_row.finding
      END AS blocker
    FROM public.post_media_coverage_references AS reference_row
    JOIN pg_temp.post_media_coverage_batch_targets AS batch
      ON batch.target_kind=reference_row.target_kind AND batch.target_id=reference_row.target_id
    JOIN public.post_media_coverage_targets AS target_row
      ON target_row.run_id=reference_row.run_id AND target_row.target_kind=reference_row.target_kind
     AND target_row.target_id=reference_row.target_id AND target_row.attempt=reference_row.attempt
    WHERE reference_row.run_id=p_run_id
    UNION ALL
    SELECT reference_row.target_kind,reference_row.target_id,'video_in_images'
    FROM public.post_media_coverage_references AS reference_row
    JOIN pg_temp.post_media_coverage_batch_targets AS batch
      ON batch.target_kind=reference_row.target_kind AND batch.target_id=reference_row.target_id
    JOIN public.post_media_coverage_targets AS target_row
      ON target_row.run_id=reference_row.run_id AND target_row.target_kind=reference_row.target_kind
     AND target_row.target_id=reference_row.target_id AND target_row.attempt=reference_row.attempt
    WHERE reference_row.run_id=p_run_id AND reference_row.expected_reference_kind='post_video'
      AND (reference_row.source_mask & 1) = 1
    UNION ALL
    SELECT target_row.target_kind,target_row.target_id,'reference_limit_exceeded'
    FROM public.post_media_coverage_targets AS target_row
    JOIN pg_temp.post_media_coverage_batch_targets AS batch
      ON batch.target_kind=target_row.target_kind AND batch.target_id=target_row.target_id
    WHERE target_row.run_id=p_run_id AND (
      SELECT pg_catalog.count(*)>64
        OR COALESCE(pg_catalog.sum(reference_row.occurrences),0)>64
      FROM public.post_media_coverage_references AS reference_row
      WHERE reference_row.run_id=target_row.run_id AND reference_row.target_kind=target_row.target_kind
        AND reference_row.target_id=target_row.target_id AND reference_row.attempt=target_row.attempt
    )
    UNION ALL
    SELECT 'group_application',app_row.id,application_evidence.blocker
    FROM public.group_applications AS app_row
    JOIN pg_temp.post_media_coverage_batch_targets AS batch
      ON batch.target_kind='group_application' AND batch.target_id=app_row.id
     AND batch.source_present
    JOIN public.post_media_coverage_targets AS application_target
      ON application_target.run_id=p_run_id
     AND application_target.target_kind='group_application'
     AND application_target.target_id=app_row.id
    LEFT JOIN public.groups AS group_row
      ON group_row.id=app_row.group_id
     AND group_row.id=ANY(v_locked_group_ids)
    CROSS JOIN LATERAL (VALUES
      ('application_unexpected_group_link',
        application_target.source_status IN ('pending','rejected') AND app_row.group_id IS NOT NULL),
      ('approved_group_missing',
        application_target.source_status='approved'
          AND (app_row.group_id IS NULL OR group_row.id IS NULL)),
      ('application_status_unsupported',
        application_target.source_status NOT IN ('pending','rejected','approved')),
      ('approved_group_owner_mismatch',
        application_target.source_status='approved' AND group_row.id IS NOT NULL
          AND group_row.created_by IS DISTINCT FROM app_row.applicant_id),
      ('approved_group_avatar_mismatch',
        CASE
          WHEN application_target.source_status='approved' AND group_row.id IS NOT NULL THEN
            CASE
              WHEN pg_catalog.octet_length(COALESCE(group_row.avatar_url,''))>262144
                OR pg_catalog.octet_length(COALESCE(app_row.avatar_url,''))>262144
              THEN false
              ELSE group_row.avatar_url IS DISTINCT FROM app_row.avatar_url
            END
          ELSE false
        END)
    ) AS application_evidence(blocker,applies)
    WHERE application_evidence.applies IS TRUE
  ) AS evidence
  WHERE evidence.blocker IS NOT NULL
  ON CONFLICT DO NOTHING;

  WITH aggregate_evidence AS (
    SELECT target_row.target_kind,target_row.target_id,target_row.attempt,target_row.eligibility,
      pg_catalog.count(reference_row.reference_key)::integer AS reference_count,
      pg_catalog.count(reference_row.reference_key) FILTER (
        WHERE reference_row.classification='canonical_managed')::integer AS managed_count,
      pg_catalog.count(reference_row.reference_key) FILTER (
        WHERE reference_row.classification='external')::integer AS external_count,
      pg_catalog.count(reference_row.reference_key) FILTER (
        WHERE reference_row.claim_state='missing')::integer AS missing_claim_count,
      pg_catalog.count(reference_row.reference_key) FILTER (
        WHERE reference_row.claim_state='conflicting')::integer AS conflicting_claim_count,
      pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(COALESCE(
        pg_catalog.string_agg(
          pg_catalog.jsonb_build_array(
            'reference-v1',reference_row.reference_key,reference_row.source_mask,
            reference_row.occurrences,reference_row.raw_sha256,reference_row.raw_length,
            reference_row.classification,reference_row.expected_reference_kind,
            reference_row.object_name,reference_row.upload_id,reference_row.registry_state,
            reference_row.storage_state,reference_row.claim_state,reference_row.finding
          )::text,
          ',' ORDER BY reference_row.reference_key COLLATE "C"
        ) FILTER (WHERE reference_row.reference_key IS NOT NULL),''),'UTF8')),'hex') AS manifest_fingerprint,
      COALESCE((SELECT pg_catalog.array_agg(blocker_row.blocker ORDER BY blocker_row.blocker COLLATE "C")
        FROM pg_temp.post_media_coverage_batch_blockers AS blocker_row
        WHERE blocker_row.target_kind=target_row.target_kind AND blocker_row.target_id=target_row.target_id),ARRAY[]::text[]) AS blockers
    FROM public.post_media_coverage_targets AS target_row
    JOIN pg_temp.post_media_coverage_batch_targets AS batch
      ON batch.target_kind=target_row.target_kind AND batch.target_id=target_row.target_id
    LEFT JOIN public.post_media_coverage_references AS reference_row
      ON reference_row.run_id=target_row.run_id AND reference_row.target_kind=target_row.target_kind
     AND reference_row.target_id=target_row.target_id AND reference_row.attempt=target_row.attempt
    WHERE target_row.run_id=p_run_id
    GROUP BY target_row.target_kind,target_row.target_id,target_row.attempt,target_row.eligibility
  ), finalized AS (
    SELECT aggregate_evidence.*,CASE
      WHEN aggregate_evidence.eligibility='source_absent' THEN 'source_absent'
      WHEN pg_catalog.cardinality(aggregate_evidence.blockers)>0 THEN 'quarantined'
      WHEN aggregate_evidence.reference_count=0 THEN 'empty'
      WHEN aggregate_evidence.managed_count=0 THEN 'external_only'
      ELSE 'covered' END AS coverage_state,
      CASE
      WHEN aggregate_evidence.managed_count=0 THEN 'not_applicable'
      WHEN aggregate_evidence.conflicting_claim_count>0 THEN 'conflicting'
      WHEN aggregate_evidence.missing_claim_count>0 THEN 'claimable'
      ELSE 'fully_claimed' END AS claim_state,
      pg_catalog.statement_timestamp() AS observed_at
    FROM aggregate_evidence
  ), sealed_attempt AS (
    UPDATE public.post_media_coverage_attempts AS attempt_row SET
      coverage_state=finalized.coverage_state,claim_state=finalized.claim_state,
      manifest_fingerprint=finalized.manifest_fingerprint,
      reference_count=finalized.reference_count,managed_count=finalized.managed_count,
      external_count=finalized.external_count,blockers=finalized.blockers,
      observed_at=finalized.observed_at
    FROM finalized
    WHERE attempt_row.run_id=p_run_id
      AND attempt_row.target_kind=finalized.target_kind
      AND attempt_row.target_id=finalized.target_id
      AND attempt_row.attempt=finalized.attempt
      AND attempt_row.observed_at IS NULL
    RETURNING attempt_row.*
  )
  UPDATE public.post_media_coverage_targets AS target_row SET
    queue_state='observed',coverage_state=sealed_attempt.coverage_state,
    claim_state=sealed_attempt.claim_state,
    manifest_fingerprint=sealed_attempt.manifest_fingerprint,
    reference_count=sealed_attempt.reference_count,managed_count=sealed_attempt.managed_count,
    external_count=sealed_attempt.external_count,blockers=sealed_attempt.blockers,
    observed_at=sealed_attempt.observed_at
  FROM sealed_attempt
  WHERE target_row.run_id=sealed_attempt.run_id
    AND target_row.target_kind=sealed_attempt.target_kind
    AND target_row.target_id=sealed_attempt.target_id
    AND target_row.attempt=sealed_attempt.attempt;

  UPDATE public.post_media_coverage_runs
  SET observed_count=observed_count+v_candidate_count
  WHERE run_id=p_run_id
  RETURNING observed_count INTO v_observed_count;
  RETURN pg_catalog.jsonb_build_object(
    'status','observed','applied',true,'run_id',p_run_id,'state',v_run.state,
    'observed',v_candidate_count,'observed_count',v_observed_count
  );
END
$function$;

ALTER FUNCTION public.install_post_media_coverage_origin_atomic(text) OWNER TO postgres;
ALTER FUNCTION public.classify_post_media_reference_lexical_internal(text,uuid,text,text) OWNER TO postgres;
ALTER FUNCTION public.start_post_media_coverage_inventory_atomic(uuid) OWNER TO postgres;
ALTER FUNCTION public.enqueue_post_media_coverage_inventory_atomic(uuid,integer) OWNER TO postgres;
ALTER FUNCTION public.observe_post_media_coverage_inventory_atomic(uuid,integer) OWNER TO postgres;
ALTER FUNCTION public.seal_post_media_coverage_inventory_atomic(uuid,integer) OWNER TO postgres;
ALTER FUNCTION public.read_post_media_coverage_gate_atomic(uuid,text) OWNER TO postgres;

DO $converge_function_acl$
DECLARE
  v_function regprocedure;
  v_service_exposed boolean;
  v_grantee record;
BEGIN
  FOR v_function,v_service_exposed IN
    SELECT expected.signature::regprocedure,expected.service_exposed
    FROM (VALUES
      ('public.install_post_media_coverage_origin_atomic(text)',false),
      ('public.classify_post_media_reference_lexical_internal(text,uuid,text,text)',false),
      ('public.start_post_media_coverage_inventory_atomic(uuid)',true),
      ('public.enqueue_post_media_coverage_inventory_atomic(uuid,integer)',true),
      ('public.observe_post_media_coverage_inventory_atomic(uuid,integer)',true),
      ('public.seal_post_media_coverage_inventory_atomic(uuid,integer)',true),
      ('public.read_post_media_coverage_gate_atomic(uuid,text)',true)
    ) AS expected(signature,service_exposed)
  LOOP
    FOR v_grantee IN
      SELECT DISTINCT acl_entry.grantee,role_row.rolname
      FROM pg_catalog.pg_proc AS function_row
      CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(
        function_row.proacl,pg_catalog.acldefault('f',function_row.proowner)
      )) AS acl_entry
      LEFT JOIN pg_catalog.pg_roles AS role_row ON role_row.oid=acl_entry.grantee
      WHERE function_row.oid=v_function AND acl_entry.grantee<>function_row.proowner
    LOOP
      IF v_grantee.grantee=0 THEN
        EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION %s FROM PUBLIC CASCADE',v_function);
      ELSIF v_grantee.rolname IS NOT NULL THEN
        EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION %s FROM %I CASCADE',v_function,v_grantee.rolname);
      END IF;
    END LOOP;
    IF v_service_exposed THEN
      EXECUTE pg_catalog.format('GRANT EXECUTE ON FUNCTION %s TO service_role',v_function);
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
  FOR v_expected IN SELECT * FROM (VALUES
    ('public.install_post_media_coverage_origin_atomic(text)','post-media-coverage:install-v1:','b9ec85013684b3afdfdb211af7dd832e'),
    ('public.classify_post_media_reference_lexical_internal(text,uuid,text,text)','post-media-coverage:classify-v1:','cb79baf8c386f7f5609577815e0da5a6'),
    ('public.start_post_media_coverage_inventory_atomic(uuid)','post-media-coverage:start-v1:','769212ff023bded3f10ff4210aaca581'),
    ('public.enqueue_post_media_coverage_inventory_atomic(uuid,integer)','post-media-coverage:enqueue-v1:','a59266eb4c13e8a7d33f88b43c82f1c1'),
    ('public.observe_post_media_coverage_inventory_atomic(uuid,integer)','post-media-coverage:observe-v1:','5b2932757927799d04d885443a03f51d'),
    ('public.seal_post_media_coverage_inventory_atomic(uuid,integer)','post-media-coverage:seal-v1:','76c473b3d26348fdbb64745f1e086f2f'),
    ('public.read_post_media_coverage_gate_atomic(uuid,text)','post-media-coverage:gate-v1:','eb5b103bf6034ba4ff268d352926210b')
  ) AS expected(signature,prefix,digest)
  LOOP
    v_function:=v_expected.signature::regprocedure;
    SELECT function_row.prosrc INTO STRICT v_source
    FROM pg_catalog.pg_proc AS function_row WHERE function_row.oid=v_function;
    IF pg_catalog.md5(v_source) IS DISTINCT FROM v_expected.digest THEN
      RAISE EXCEPTION 'post media coverage reviewed source digest drifted: %',v_function;
    END IF;
    EXECUTE pg_catalog.format(
      'COMMENT ON FUNCTION %s IS %L',v_function,v_expected.prefix || v_expected.digest
    );
  END LOOP;
END
$seal_functions$;

CREATE OR REPLACE FUNCTION pg_temp.post_media_coverage_fk_triggers_are_safe()
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog,public,pg_temp
AS $function$
  WITH foreign_key AS (
    SELECT constraint_row.oid,constraint_row.conrelid,constraint_row.confrelid,
      constraint_row.conindid
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE (constraint_row.conrelid='public.post_media_coverage_targets'::regclass
        AND constraint_row.confrelid='public.post_media_coverage_runs'::regclass
        AND constraint_row.conname='post_media_coverage_targets_run_fkey')
       OR (constraint_row.conrelid='public.post_media_coverage_references'::regclass
        AND constraint_row.confrelid='public.post_media_coverage_attempts'::regclass
        AND constraint_row.conname='post_media_coverage_references_attempt_fkey')
       OR (constraint_row.conrelid='public.post_media_coverage_attempts'::regclass
        AND constraint_row.confrelid='public.post_media_coverage_targets'::regclass
        AND constraint_row.conname='post_media_coverage_attempts_target_fkey')
  ), expected AS (
    SELECT foreign_key.oid AS constraint_oid,foreign_key.conrelid AS relation_oid,
      foreign_key.confrelid AS other_oid,foreign_key.conindid,
      'pg_catalog."RI_FKey_check_ins"()'::regprocedure::oid AS function_oid,5::smallint AS trigger_type
    FROM foreign_key
    UNION ALL SELECT foreign_key.oid,foreign_key.conrelid,foreign_key.confrelid,foreign_key.conindid,
      'pg_catalog."RI_FKey_check_upd"()'::regprocedure::oid,17::smallint FROM foreign_key
    UNION ALL SELECT foreign_key.oid,foreign_key.confrelid,foreign_key.conrelid,foreign_key.conindid,
      'pg_catalog."RI_FKey_restrict_del"()'::regprocedure::oid,9::smallint FROM foreign_key
    UNION ALL SELECT foreign_key.oid,foreign_key.confrelid,foreign_key.conrelid,foreign_key.conindid,
      'pg_catalog."RI_FKey_restrict_upd"()'::regprocedure::oid,17::smallint FROM foreign_key
  ), actual AS (
    SELECT trigger_row.* FROM foreign_key
    JOIN pg_catalog.pg_trigger AS trigger_row ON trigger_row.tgconstraint=foreign_key.oid
  )
  SELECT (SELECT pg_catalog.count(*) FROM foreign_key)=3
    AND (SELECT pg_catalog.count(*) FROM actual)=12
    AND NOT EXISTS (
      SELECT 1 FROM expected
      FULL JOIN actual ON actual.tgconstraint=expected.constraint_oid
        AND actual.tgrelid=expected.relation_oid AND actual.tgfoid=expected.function_oid
        AND actual.tgtype=expected.trigger_type
      WHERE expected.constraint_oid IS NULL OR actual.oid IS NULL
        OR NOT actual.tgisinternal OR actual.tgenabled<>'O'
        OR actual.tgdeferrable OR actual.tginitdeferred OR actual.tgparentid<>0
        OR actual.tgconstrindid IS DISTINCT FROM expected.conindid
        OR actual.tgnargs<>0 OR actual.tgattr<>''::pg_catalog.int2vector
        OR pg_catalog.octet_length(actual.tgargs)<>0
        OR actual.tgconstrrelid IS DISTINCT FROM expected.other_oid
        OR actual.tgqual IS NOT NULL OR actual.tgoldtable IS NOT NULL OR actual.tgnewtable IS NOT NULL
    )
$function$;

DO $postflight$
BEGIN
  IF NOT pg_temp.post_media_coverage_tables_are_exact() THEN
    RAISE EXCEPTION 'post media coverage table catalog or ACL seal failed';
  ELSIF NOT pg_temp.post_media_coverage_fk_triggers_are_safe() THEN
    RAISE EXCEPTION 'post media coverage RI trigger seal failed';
  ELSIF NOT pg_temp.post_media_coverage_publication_is_exact() THEN
    RAISE EXCEPTION 'post media coverage function source or ACL seal failed';
  ELSIF NOT pg_temp.post_media_coverage_role_graph_is_safe() THEN
    RAISE EXCEPTION 'post media coverage role seal failed';
  ELSIF NOT pg_temp.post_media_coverage_foundations_are_exact() THEN
    RAISE EXCEPTION 'post media coverage dependency seal failed';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.pronamespace='public'::regnamespace
      AND function_row.proname IN (
        'install_post_media_coverage_origin_atomic','classify_post_media_reference_lexical_internal',
        'start_post_media_coverage_inventory_atomic','enqueue_post_media_coverage_inventory_atomic',
        'observe_post_media_coverage_inventory_atomic','seal_post_media_coverage_inventory_atomic',
        'read_post_media_coverage_gate_atomic'
      )
      AND function_row.pronargdefaults<>0
  ) THEN
    RAISE EXCEPTION 'post media coverage function default metadata drifted';
  END IF;
END
$postflight$;

NOTIFY pgrst,'reload schema';

COMMIT;
