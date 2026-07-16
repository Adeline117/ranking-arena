-- Exchange credentials and ownership proof are server-managed security state.
-- Browser roles must use the authenticated exchange API routes and must never
-- read ciphertext or write verified_uid / scope_permissions through PostgREST.
--
-- Rollout dependency: deploy 61b2a00b3 (the admin-client API cutover) before
-- applying this migration. Applying the ACL first would intentionally fail
-- closed, but would temporarily break the browser connection flows.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended(
    'public.user_exchange_connections:server-only-acl',
    0
  )
);

-- Refuse to install a partial boundary on a drifted schema. The unique owner
-- key is also the conflict target used by the server-side connection upserts.
DO $preflight$
DECLARE
  v_relation regclass := pg_catalog.to_regclass(
    'public.user_exchange_connections'
  );
  v_invalid_columns text[];
  v_missing_roles text[];
BEGIN
  IF v_relation IS NULL THEN
    RAISE EXCEPTION
      'public.user_exchange_connections must exist before ACL hardening';
  END IF;

  IF (
    SELECT relation.relkind
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = v_relation
  ) NOT IN ('r', 'p') THEN
    RAISE EXCEPTION
      'public.user_exchange_connections must be a table or partitioned table';
  END IF;

  SELECT pg_catalog.array_agg(required_role ORDER BY required_role)
  INTO v_missing_roles
  FROM pg_catalog.unnest(
    ARRAY['anon', 'authenticated', 'service_role']::text[]
  ) AS required_role
  WHERE NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = required_role
  );

  IF v_missing_roles IS NOT NULL THEN
    RAISE EXCEPTION
      'exchange connection ACL roles are missing: %',
      v_missing_roles;
  END IF;

  -- Require the credential/proof columns defined by repository migrations.
  -- OAuth token columns were historically added out of band in some stacks;
  -- the dynamic column revoke below secures them whenever they are present
  -- without making a clean migration replay depend on that historical drift.
  SELECT pg_catalog.array_agg(
    pg_catalog.format(
      '%I (expected %s%s)',
      required_column.column_name,
      required_column.type_name,
      CASE
        WHEN required_column.required_not_null THEN ' NOT NULL'
        ELSE ''
      END
    )
    ORDER BY required_column.ordinality
  )
  INTO v_invalid_columns
  FROM (
    VALUES
      (1, 'id', 'uuid', true),
      (2, 'user_id', 'uuid', true),
      (3, 'exchange', 'text', true),
      (4, 'api_key_encrypted', 'text', true),
      (5, 'api_secret_encrypted', 'text', true),
      (6, 'passphrase_encrypted', 'text', false),
      (7, 'is_active', 'boolean', false),
      (8, 'verified_uid', 'text', false),
      (9, 'last_verified_at', 'timestamp with time zone', false),
      (10, 'scope_permissions', 'jsonb', false)
  ) AS required_column(
    ordinality,
    column_name,
    type_name,
    required_not_null
  )
  LEFT JOIN pg_catalog.pg_attribute AS attribute
    ON attribute.attrelid = v_relation
   AND attribute.attname = required_column.column_name
   AND attribute.attnum > 0
   AND NOT attribute.attisdropped
  WHERE attribute.attname IS NULL
     OR pg_catalog.format_type(attribute.atttypid, attribute.atttypmod)
          <> required_column.type_name
     OR (
       required_column.required_not_null
       AND NOT attribute.attnotnull
     );

  IF v_invalid_columns IS NOT NULL THEN
    RAISE EXCEPTION
      'public.user_exchange_connections has missing or incompatible security columns: %',
      v_invalid_columns;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index AS index_metadata
    WHERE index_metadata.indrelid = v_relation
      AND index_metadata.indisunique
      AND index_metadata.indisvalid
      AND index_metadata.indisready
      AND NOT index_metadata.indisexclusion
      AND index_metadata.indpred IS NULL
      AND index_metadata.indexprs IS NULL
      AND index_metadata.indnkeyatts = 2
      AND index_metadata.indnatts = 2
      AND (
        SELECT pg_catalog.array_agg(
          attribute.attname
          ORDER BY key_column.ordinality
        )
        FROM pg_catalog.unnest(index_metadata.indkey)
          WITH ORDINALITY AS key_column(attnum, ordinality)
        JOIN pg_catalog.pg_attribute AS attribute
          ON attribute.attrelid = index_metadata.indrelid
         AND attribute.attnum = key_column.attnum
      ) = ARRAY['user_id', 'exchange']::name[]
  ) THEN
    RAISE EXCEPTION
      'public.user_exchange_connections requires a valid unique (user_id, exchange) key';
  END IF;
END
$preflight$;

LOCK TABLE public.user_exchange_connections IN ACCESS EXCLUSIVE MODE;

ALTER TABLE public.user_exchange_connections ENABLE ROW LEVEL SECURITY;

-- Remove table privileges including TRUNCATE, REFERENCES, and TRIGGER. Column
-- ACLs are independent in PostgreSQL, so revoke those explicitly as well.
REVOKE ALL PRIVILEGES ON TABLE public.user_exchange_connections
  FROM PUBLIC, anon, authenticated, service_role;

DO $revoke_column_privileges$
DECLARE
  v_column_list text;
BEGIN
  SELECT pg_catalog.string_agg(
    pg_catalog.format('%I', attribute.attname),
    ', '
    ORDER BY attribute.attnum
  )
  INTO v_column_list
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.user_exchange_connections'::regclass
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;

  IF v_column_list IS NULL THEN
    RAISE EXCEPTION
      'public.user_exchange_connections has no columns to secure';
  END IF;

  EXECUTE pg_catalog.format(
    'REVOKE SELECT (%1$s), INSERT (%1$s), UPDATE (%1$s), REFERENCES (%1$s) '
      || 'ON TABLE public.user_exchange_connections '
      || 'FROM PUBLIC, anon, authenticated, service_role',
    v_column_list
  );
END
$revoke_column_privileges$;

-- Policy names changed repeatedly in historical migrations. Drop everything
-- currently attached to this base table so unknown dashboard/manual drift is
-- closed too, then rebuild the single intended policy.
DO $drop_exchange_connection_policies$
DECLARE
  v_policy_name name;
BEGIN
  FOR v_policy_name IN
    SELECT policy.polname
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.user_exchange_connections'::regclass
    ORDER BY policy.polname
  LOOP
    EXECUTE pg_catalog.format(
      'DROP POLICY %I ON public.user_exchange_connections',
      v_policy_name
    );
  END LOOP;
END
$drop_exchange_connection_policies$;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.user_exchange_connections
  TO service_role;

-- service_role currently has BYPASSRLS in Supabase. Keep an explicit policy
-- so the server contract continues to work if that role property changes.
CREATE POLICY "Service role manages exchange connections"
  ON public.user_exchange_connections
  AS PERMISSIVE
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Fail the transaction if any table, column, or policy path would still let a
-- browser role reach the base table, or if service_role received extra powers.
DO $postflight$
DECLARE
  v_relation regclass := 'public.user_exchange_connections'::regclass;
  v_role name;
  v_privilege text;
  v_column name;
  v_service_role_oid oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'service_role'
  );
BEGIN
  IF NOT (
    SELECT relation.relrowsecurity
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = v_relation
  ) THEN
    RAISE EXCEPTION
      'row level security is not enabled on public.user_exchange_connections';
  END IF;

  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated']::name[]
  LOOP
    FOREACH v_privilege IN ARRAY ARRAY[
      'SELECT',
      'INSERT',
      'UPDATE',
      'DELETE',
      'TRUNCATE',
      'REFERENCES',
      'TRIGGER'
    ]::text[]
    LOOP
      IF pg_catalog.has_table_privilege(
        v_role,
        v_relation,
        v_privilege
      ) THEN
        RAISE EXCEPTION
          '% still has % on public.user_exchange_connections',
          v_role,
          v_privilege;
      END IF;
    END LOOP;

    FOR v_column IN
      SELECT attribute.attname
      FROM pg_catalog.pg_attribute AS attribute
      WHERE attribute.attrelid = v_relation
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
      ORDER BY attribute.attnum
    LOOP
      FOREACH v_privilege IN ARRAY ARRAY[
        'SELECT',
        'INSERT',
        'UPDATE',
        'REFERENCES'
      ]::text[]
      LOOP
        IF pg_catalog.has_column_privilege(
          v_role,
          v_relation,
          v_column,
          v_privilege
        ) THEN
          RAISE EXCEPTION
            '% still has column % on public.user_exchange_connections.%',
            v_role,
            v_privilege,
            v_column;
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;

  -- PUBLIC is not a pg_roles row. Inspect ACL entries with grantee = 0 so a
  -- default-role grant cannot hide behind the role privilege helpers above.
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
      AND acl_entry.grantee = 0::oid
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl_entry
    WHERE attribute.attrelid = v_relation
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND acl_entry.grantee = 0::oid
  ) THEN
    RAISE EXCEPTION
      'PUBLIC privileges remain on public.user_exchange_connections';
  END IF;

  -- No direct column ACL should remain for any application role. The table
  -- grant below is the sole source of service_role CRUD privileges.
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl_entry
    WHERE attribute.attrelid = v_relation
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND acl_entry.grantee IN (
        0::oid,
        (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'anon'),
        (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'authenticated'),
        v_service_role_oid
      )
  ) THEN
    RAISE EXCEPTION
      'application-role column ACL remains on public.user_exchange_connections';
  END IF;

  FOREACH v_privilege IN ARRAY ARRAY[
    'SELECT',
    'INSERT',
    'UPDATE',
    'DELETE'
  ]::text[]
  LOOP
    IF NOT pg_catalog.has_table_privilege(
      'service_role',
      v_relation,
      v_privilege
    ) THEN
      RAISE EXCEPTION
        'service_role is missing % on public.user_exchange_connections',
        v_privilege;
    END IF;
  END LOOP;

  FOREACH v_privilege IN ARRAY ARRAY[
    'TRUNCATE',
    'REFERENCES',
    'TRIGGER'
  ]::text[]
  LOOP
    IF pg_catalog.has_table_privilege(
      'service_role',
      v_relation,
      v_privilege
    ) THEN
      RAISE EXCEPTION
        'service_role unexpectedly has % on public.user_exchange_connections',
        v_privilege;
    END IF;
  END LOOP;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = v_relation
  ) <> 1 OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = v_relation
      AND policy.polname = 'Service role manages exchange connections'
      AND policy.polpermissive
      AND policy.polcmd = '*'
      AND policy.polroles = ARRAY[v_service_role_oid]::oid[]
      AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid) = 'true'
      AND pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid) = 'true'
  ) THEN
    RAISE EXCEPTION
      'exchange connection RLS policies did not converge to service-only ALL';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
