-- Trader authorization rows contain encrypted exchange credentials and the
-- trust fields that decide whether first-party data may be published. Browser
-- roles must use the authenticated authorization APIs; owning a row is not
-- permission to read its ciphertext or forge read_only_verified_at/sync state.
--
-- This migration is schema-ahead compatible with the existing service-owned
-- writers and installs the atomic account-binding RPC used by the next app
-- release. Browser roles never receive direct credential-table or RPC access.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended(
    'public.trader_authorizations:server-only-acl',
    0
  )
);

-- Refuse to install a partial boundary on a drifted schema. The three-column
-- unique key is the conflict target used by both service-owned upsert paths.
DO $preflight$
DECLARE
  v_relation regclass := pg_catalog.to_regclass(
    'public.trader_authorizations'
  );
  v_connection_relation regclass := pg_catalog.to_regclass(
    'public.user_exchange_connections'
  );
  v_invalid_columns text[];
  v_missing_roles text[];
  v_unexpected_overloads text[];
BEGIN
  IF v_relation IS NULL THEN
    RAISE EXCEPTION
      'public.trader_authorizations must exist before ACL hardening';
  END IF;

  IF (
    SELECT relation.relkind
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = v_relation
  ) IS DISTINCT FROM 'r' THEN
    RAISE EXCEPTION
      'public.trader_authorizations must be an ordinary table';
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
      'trader authorization ACL roles are missing: %',
      v_missing_roles;
  END IF;

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
      (3, 'platform', 'text', true),
      (4, 'trader_id', 'text', true),
      (5, 'encrypted_api_key', 'text', true),
      (6, 'encrypted_api_secret', 'text', true),
      (7, 'encrypted_passphrase', 'text', false),
      (8, 'permissions', 'jsonb', false),
      (9, 'status', 'text', true),
      (10, 'last_verified_at', 'timestamp with time zone', false),
      (11, 'read_only_verified_at', 'timestamp with time zone', false),
      (12, 'last_sync_at', 'timestamp with time zone', false),
      (13, 'last_sync_status', 'text', false),
      (14, 'consecutive_failures', 'integer', true),
      (15, 'verification_error', 'text', false),
      (16, 'sync_frequency', 'text', false),
      (17, 'label', 'text', false),
      (18, 'updated_at', 'timestamp with time zone', false)
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
      'public.trader_authorizations has missing or incompatible security columns: %',
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
      AND index_metadata.indnkeyatts = 3
      AND index_metadata.indnatts = 3
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
      ) = ARRAY['user_id', 'platform', 'trader_id']::name[]
  ) THEN
    RAISE EXCEPTION
      'public.trader_authorizations requires a valid unique (user_id, platform, trader_id) key';
  END IF;

  IF v_connection_relation IS NULL THEN
    RAISE EXCEPTION
      'public.user_exchange_connections must exist before atomic account binding';
  END IF;

  IF (
    SELECT relation.relkind
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = v_connection_relation
  ) IS DISTINCT FROM 'r' THEN
    RAISE EXCEPTION
      'public.user_exchange_connections must be an ordinary table';
  END IF;

  IF CURRENT_USER IS DISTINCT FROM (
       SELECT pg_catalog.pg_get_userbyid(relation.relowner)
       FROM pg_catalog.pg_class AS relation
       WHERE relation.oid = v_relation
     ) OR CURRENT_USER IS DISTINCT FROM (
       SELECT pg_catalog.pg_get_userbyid(relation.relowner)
       FROM pg_catalog.pg_class AS relation
       WHERE relation.oid = v_connection_relation
     ) THEN
    RAISE EXCEPTION
      'migration role must own both account authorization relations';
  END IF;

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
      (10, 'scope_permissions', 'jsonb', false),
      (11, 'updated_at', 'timestamp with time zone', false)
  ) AS required_column(
    ordinality,
    column_name,
    type_name,
    required_not_null
  )
  LEFT JOIN pg_catalog.pg_attribute AS attribute
    ON attribute.attrelid = v_connection_relation
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
      'public.user_exchange_connections has missing or incompatible atomic-binding columns: %',
      v_invalid_columns;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index AS index_metadata
    WHERE index_metadata.indrelid = v_connection_relation
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

  -- The binder is safe only when the connection registry already satisfies the
  -- July service-only boundary. Do not silently install a definer RPC on top of
  -- a table whose ciphertext or trust fields remain browser-accessible.
  IF NOT (
       SELECT relation.relrowsecurity
       FROM pg_catalog.pg_class AS relation
       WHERE relation.oid = v_connection_relation
     ) OR EXISTS (
       SELECT 1
       FROM pg_catalog.unnest(
         ARRAY['anon', 'authenticated']::name[]
       ) AS browser_role(role_name)
       CROSS JOIN pg_catalog.unnest(
         ARRAY[
           'SELECT',
           'INSERT',
           'UPDATE',
           'DELETE',
           'TRUNCATE',
           'REFERENCES',
           'TRIGGER'
         ]::text[]
       ) AS permission(privilege_name)
       WHERE pg_catalog.has_table_privilege(
         browser_role.role_name,
         v_connection_relation,
         permission.privilege_name
       )
     ) OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_attribute AS attribute
       CROSS JOIN pg_catalog.unnest(
         ARRAY['anon', 'authenticated']::name[]
       ) AS browser_role(role_name)
       CROSS JOIN pg_catalog.unnest(
         ARRAY['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']::text[]
       ) AS permission(privilege_name)
       WHERE attribute.attrelid = v_connection_relation
         AND attribute.attnum > 0
         AND NOT attribute.attisdropped
         AND pg_catalog.has_column_privilege(
           browser_role.role_name,
           v_connection_relation,
           attribute.attname,
           permission.privilege_name
         )
     ) OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_class AS relation
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(
           relation.relacl,
           pg_catalog.acldefault('r', relation.relowner)
         )
       ) AS acl_entry
       WHERE relation.oid = v_connection_relation
         AND acl_entry.grantee = 0::oid
     ) OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_class AS relation
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(
           relation.relacl,
           pg_catalog.acldefault('r', relation.relowner)
         )
       ) AS acl_entry
       WHERE relation.oid = v_connection_relation
         AND acl_entry.grantee <> relation.relowner
         AND NOT (
           acl_entry.grantee = (
             SELECT role_row.oid
             FROM pg_catalog.pg_roles AS role_row
             WHERE role_row.rolname = 'service_role'
           )
           AND acl_entry.privilege_type = ANY(
             ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']::text[]
           )
           AND NOT acl_entry.is_grantable
         )
     ) OR (
       SELECT pg_catalog.count(*)
       FROM pg_catalog.pg_class AS relation
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(
           relation.relacl,
           pg_catalog.acldefault('r', relation.relowner)
         )
       ) AS acl_entry
       WHERE relation.oid = v_connection_relation
         AND acl_entry.grantee = (
           SELECT role_row.oid
           FROM pg_catalog.pg_roles AS role_row
           WHERE role_row.rolname = 'service_role'
         )
         AND acl_entry.privilege_type = ANY(
           ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']::text[]
         )
         AND NOT acl_entry.is_grantable
     ) <> 4 OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_attribute AS attribute
       CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl_entry
       WHERE attribute.attrelid = v_connection_relation
         AND attribute.attnum > 0
         AND NOT attribute.attisdropped
         AND acl_entry.grantee IN (
           0::oid,
           (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'anon'),
           (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'authenticated'),
           (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'service_role')
         )
     ) OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_attribute AS attribute
       CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl_entry
       JOIN pg_catalog.pg_class AS relation
         ON relation.oid = attribute.attrelid
       WHERE attribute.attrelid = v_connection_relation
         AND attribute.attnum > 0
         AND NOT attribute.attisdropped
         AND acl_entry.grantee <> relation.relowner
     ) OR EXISTS (
       SELECT 1
       FROM pg_catalog.unnest(
         ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']::text[]
       ) AS required_privilege(privilege_name)
       WHERE NOT pg_catalog.has_table_privilege(
         'service_role',
         v_connection_relation,
         required_privilege.privilege_name
       )
     ) OR EXISTS (
       SELECT 1
       FROM pg_catalog.unnest(
         ARRAY['TRUNCATE', 'REFERENCES', 'TRIGGER']::text[]
       ) AS forbidden_privilege(privilege_name)
       WHERE pg_catalog.has_table_privilege(
         'service_role',
         v_connection_relation,
         forbidden_privilege.privilege_name
       )
     ) OR (
       SELECT pg_catalog.count(*)
       FROM pg_catalog.pg_policy AS policy
       WHERE policy.polrelid = v_connection_relation
     ) <> 1 OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_policy AS policy
       JOIN pg_catalog.pg_roles AS role_row
         ON policy.polroles = ARRAY[role_row.oid]::oid[]
       WHERE policy.polrelid = v_connection_relation
         AND policy.polname = 'Service role manages exchange connections'
         AND policy.polpermissive
         AND policy.polcmd = '*'
         AND role_row.rolname = 'service_role'
         AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid) = 'true'
         AND pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid) = 'true'
     ) THEN
    RAISE EXCEPTION
      'public.user_exchange_connections must satisfy 20260716112000_exchange_connections_server_only before atomic account binding';
  END IF;

  WITH expected(proname, signature) AS (
    VALUES
      (
        'bind_trader_account_connection_v1'::name,
        'public.bind_trader_account_connection_v1(uuid,text,text,text,text,text,jsonb,timestamptz,text,text)'::text
      ),
      (
        'revoke_trader_account_connection_v1'::name,
        'public.revoke_trader_account_connection_v1(uuid,uuid,text)'::text
      ),
      (
        'guard_trader_authorization_v1_contract'::name,
        'public.guard_trader_authorization_v1_contract()'::text
      ),
      (
        'serialize_exchange_connection_v1_mutation'::name,
        'public.serialize_exchange_connection_v1_mutation()'::text
      ),
      (
        'guard_exchange_connection_authorization_v1_contract'::name,
        'public.guard_exchange_connection_authorization_v1_contract()'::text
      ),
      (
        'update_updated_at_column'::name,
        'public.update_updated_at_column()'::text
      ),
      (
        'update_trader_authorizations_updated_at'::name,
        'public.update_trader_authorizations_updated_at()'::text
      )
  )
  SELECT pg_catalog.array_agg(
    pg_catalog.format(
      '%I(%s)',
      procedure_row.proname,
      pg_catalog.pg_get_function_identity_arguments(procedure_row.oid)
    )
    ORDER BY procedure_row.proname, procedure_row.oid
  )
  INTO v_unexpected_overloads
  FROM pg_catalog.pg_proc AS procedure_row
  JOIN pg_catalog.pg_namespace AS namespace_row
    ON namespace_row.oid = procedure_row.pronamespace
  WHERE namespace_row.nspname = 'public'
    AND procedure_row.proname IN (SELECT expected.proname FROM expected)
    AND NOT EXISTS (
      SELECT 1
      FROM expected
      WHERE expected.proname = procedure_row.proname
        AND procedure_row.oid IS NOT DISTINCT FROM
              pg_catalog.to_regprocedure(expected.signature)
    );

  IF v_unexpected_overloads IS NOT NULL THEN
    RAISE EXCEPTION
      'unexpected trader-authorization function overloads must be retired first: %',
      v_unexpected_overloads;
  END IF;
END
$preflight$;

-- Match the existing claim-activation lock order: connection first, then
-- authorization. The bounded migration lock also prevents a partial catalog
-- cutover while the RPC and ACL boundary are installed.
LOCK TABLE public.user_exchange_connections IN ACCESS EXCLUSIVE MODE;
LOCK TABLE public.trader_authorizations IN ACCESS EXCLUSIVE MODE;

DO $pre_dml_trigger_inventory$
DECLARE
  v_unexpected_triggers text[];
BEGIN
  SELECT pg_catalog.array_agg(
    pg_catalog.format('%s.%I', trigger_row.tgrelid::regclass, trigger_row.tgname)
    ORDER BY trigger_row.tgrelid::regclass::text, trigger_row.tgname
  )
  INTO v_unexpected_triggers
  FROM pg_catalog.pg_trigger AS trigger_row
  WHERE trigger_row.tgrelid IN (
    'public.user_exchange_connections'::regclass,
    'public.trader_authorizations'::regclass
  )
    AND NOT trigger_row.tgisinternal
    AND NOT (
      (
        trigger_row.tgrelid = 'public.user_exchange_connections'::regclass
        AND trigger_row.tgname IN (
          'trigger_user_exchange_connections_updated_at',
          'exchange_connection_v1_mutation_serializer',
          'exchange_connection_authorization_v1_contract_guard'
        )
      ) OR (
        trigger_row.tgrelid = 'public.trader_authorizations'::regclass
        AND trigger_row.tgname IN (
          'trigger_update_trader_authorizations_updated_at',
          'trader_authorization_v1_contract_guard'
        )
      )
    );

  IF v_unexpected_triggers IS NOT NULL THEN
    RAISE EXCEPTION
      'unexpected account triggers must be retired before quarantine DML: %',
      v_unexpected_triggers;
  END IF;
END
$pre_dml_trigger_inventory$;

-- A replay may encounter canonical-name triggers whose historical owner has
-- replaced the function body. Remove every account invariant trigger before
-- quarantine DML, then rebuild every reviewed trigger from canonical functions.
DROP TRIGGER IF EXISTS trigger_user_exchange_connections_updated_at
  ON public.user_exchange_connections;
DROP TRIGGER IF EXISTS exchange_connection_v1_mutation_serializer
  ON public.user_exchange_connections;
DROP TRIGGER IF EXISTS exchange_connection_authorization_v1_contract_guard
  ON public.user_exchange_connections;
DROP TRIGGER IF EXISTS trigger_update_trader_authorizations_updated_at
  ON public.trader_authorizations;
DROP TRIGGER IF EXISTS trader_authorization_v1_contract_guard
  ON public.trader_authorizations;

CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  NEW.updated_at = pg_catalog.now();
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.update_trader_authorizations_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  NEW.updated_at = pg_catalog.now();
  RETURN NEW;
END;
$function$;

ALTER FUNCTION public.update_updated_at_column() OWNER TO CURRENT_USER;
ALTER FUNCTION public.update_trader_authorizations_updated_at()
  OWNER TO CURRENT_USER;
REVOKE ALL ON FUNCTION public.update_updated_at_column()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.update_trader_authorizations_updated_at()
  FROM PUBLIC, anon, authenticated, service_role;

ALTER TABLE public.trader_authorizations ENABLE ROW LEVEL SECURITY;

-- Fail closed every connection that predates the canonical, attested V1
-- boundary. Historical binders wrote product aliases such as
-- binance_futures as independent active rows, while the retired OAuth path
-- wrote placeholder API-key values without the same read-only proof. Retain
-- ciphertext for the owner audit/rebind workflow, but no worker may consume
-- those rows after this migration commits.
UPDATE public.user_exchange_connections AS connection
SET is_active = false,
    updated_at = pg_catalog.statement_timestamp()
WHERE connection.is_active IS TRUE
  AND (
    connection.exchange NOT IN ('binance', 'bybit', 'okx', 'bitget')
    OR connection.verified_uid IS NULL
    OR pg_catalog.btrim(connection.verified_uid) = ''
    OR connection.last_verified_at IS NULL
    OR CASE
      WHEN pg_catalog.jsonb_typeof(connection.scope_permissions) = 'array'
        THEN pg_catalog.jsonb_array_length(connection.scope_permissions) = 0
      ELSE true
    END
    OR pg_catalog.lower(pg_catalog.btrim(connection.api_key_encrypted)) = 'oauth'
    OR pg_catalog.lower(pg_catalog.btrim(connection.api_secret_encrypted)) = 'oauth'
    OR (
      connection.exchange IN ('okx', 'bitget')
      AND (
        connection.passphrase_encrypted IS NULL
        OR pg_catalog.btrim(connection.passphrase_encrypted) = ''
      )
    )
  );

-- A worker consumes trader_authorizations, not the connection table. Revoke
-- every active row that does not have one unique, exact, active canonical
-- connection with the same attested UID. This closes the pre-cutover split in
-- which an alias connection is quarantined but its sibling authorization keeps
-- syncing, and also fails closed ambiguous duplicate authorizations.
WITH active_authorizations AS (
  SELECT
    auth_row.id,
    auth_row.user_id,
    auth_row.trader_id,
    CASE
      WHEN auth_row.platform
             IN ('binance', 'binance_futures', 'binance_spot') THEN 'binance'
      WHEN auth_row.platform IN ('bybit', 'bybit_spot') THEN 'bybit'
      WHEN auth_row.platform
             IN ('okx', 'okx_futures', 'okx_spot') THEN 'okx'
      WHEN auth_row.platform
             IN ('bitget', 'bitget_futures', 'bitget_spot') THEN 'bitget'
      ELSE NULL
    END AS canonical_exchange
  FROM public.trader_authorizations AS auth_row
  WHERE auth_row.status = 'active'
), unsafe_authorizations AS (
  SELECT candidate.id
  FROM active_authorizations AS candidate
  JOIN public.trader_authorizations AS auth_row
    ON auth_row.id = candidate.id
  WHERE candidate.canonical_exchange IS NULL
     OR auth_row.read_only_verified_at IS NULL
     OR auth_row.last_verified_at IS NULL
     OR pg_catalog.btrim(auth_row.encrypted_api_key) = ''
     OR pg_catalog.btrim(auth_row.encrypted_api_secret) = ''
     OR (
       candidate.canonical_exchange IN ('okx', 'bitget')
       AND (
         auth_row.encrypted_passphrase IS NULL
         OR pg_catalog.btrim(auth_row.encrypted_passphrase) = ''
       )
     )
     OR CASE
       WHEN pg_catalog.jsonb_typeof(auth_row.permissions) = 'array'
         THEN pg_catalog.jsonb_array_length(auth_row.permissions) = 0
       ELSE true
     END
     OR NOT EXISTS (
       SELECT 1
       FROM public.user_exchange_connections AS connection
       WHERE connection.user_id = candidate.user_id
         AND connection.exchange = candidate.canonical_exchange
         AND connection.verified_uid = candidate.trader_id
         AND connection.is_active IS TRUE
         AND connection.api_key_encrypted = auth_row.encrypted_api_key
         AND connection.api_secret_encrypted = auth_row.encrypted_api_secret
         AND connection.passphrase_encrypted
               IS NOT DISTINCT FROM auth_row.encrypted_passphrase
         AND connection.scope_permissions
               IS NOT DISTINCT FROM auth_row.permissions
         AND connection.last_verified_at
               IS NOT DISTINCT FROM auth_row.read_only_verified_at
         AND connection.last_verified_at
               IS NOT DISTINCT FROM auth_row.last_verified_at
     )
     OR (
       SELECT pg_catalog.count(*)
       FROM active_authorizations AS sibling
       WHERE sibling.user_id = candidate.user_id
         AND sibling.canonical_exchange = candidate.canonical_exchange
     ) <> 1
)
UPDATE public.trader_authorizations AS auth_row
SET status = 'revoked',
    verification_error = 'Quarantined: no unique attested canonical account connection',
    updated_at = pg_catalog.statement_timestamp()
WHERE auth_row.id IN (
  SELECT unsafe.id
  FROM unsafe_authorizations AS unsafe
);

-- Immutable deployments of the retired bind-wallet endpoint used recognizable
-- pseudo-credential markers and wallet_owner permission instead of a proven
-- read-only exchange credential. Quarantine them before installing a validated
-- constraint so they can never become active or be recreated.
UPDATE public.trader_authorizations AS auth_row
SET status = 'revoked',
    permissions = CASE
      WHEN COALESCE(auth_row.permissions, '[]'::jsonb)::text
             ~* '"wallet_owner"'
      THEN '[]'::jsonb
      ELSE auth_row.permissions
    END,
    encrypted_api_key = CASE
      WHEN auth_row.encrypted_api_key LIKE 'wallet:%' THEN 'retired-wallet-marker'
      ELSE auth_row.encrypted_api_key
    END,
    encrypted_api_secret = CASE
      WHEN auth_row.encrypted_api_secret LIKE 'signature_verified:%'
      THEN 'retired-wallet-marker'
      ELSE auth_row.encrypted_api_secret
    END,
    read_only_verified_at = NULL,
    last_sync_status = 'failed',
    verification_error = 'Retired bind-wallet authorization is not a V1 claim or verified-data credential',
    updated_at = pg_catalog.statement_timestamp()
WHERE COALESCE(auth_row.permissions, '[]'::jsonb)::text ~* '"wallet_owner"'
   OR auth_row.encrypted_api_key LIKE 'wallet:%'
   OR auth_row.encrypted_api_secret LIKE 'signature_verified:%';

ALTER TABLE public.trader_authorizations
  DROP CONSTRAINT IF EXISTS trader_authorizations_no_legacy_wallet_marker;
ALTER TABLE public.trader_authorizations
  ADD CONSTRAINT trader_authorizations_no_legacy_wallet_marker
  CHECK (
    NOT (COALESCE(permissions, '[]'::jsonb)::text ~* '"wallet_owner"')
    AND encrypted_api_key NOT LIKE 'wallet:%'
    AND encrypted_api_secret NOT LIKE 'signature_verified:%'
  ) NOT VALID;
ALTER TABLE public.trader_authorizations
  VALIDATE CONSTRAINT trader_authorizations_no_legacy_wallet_marker;

-- Restore timestamp maintenance only after quarantine has written its explicit
-- statement timestamps. The canonical invariant triggers remain disabled until
-- their reviewed bodies are rebuilt below.
CREATE TRIGGER trigger_user_exchange_connections_updated_at
  BEFORE UPDATE ON public.user_exchange_connections
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER trigger_update_trader_authorizations_updated_at
  BEFORE UPDATE ON public.trader_authorizations
  FOR EACH ROW
  EXECUTE FUNCTION public.update_trader_authorizations_updated_at();

-- Supabase historically granted broad table privileges to browser roles.
-- Column ACLs are independent, so remove both forms before rebuilding access.
REVOKE ALL PRIVILEGES ON TABLE public.trader_authorizations
  FROM PUBLIC, anon, authenticated, service_role;

DO $revoke_non_owner_table_acl$
DECLARE
  v_grantee oid;
  v_role_sql text;
BEGIN
  FOR v_grantee IN
    SELECT DISTINCT acl_entry.grantee
    FROM pg_catalog.pg_class AS relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
    ) AS acl_entry
    WHERE relation.oid = 'public.trader_authorizations'::regclass
      AND acl_entry.grantee <> relation.relowner
  LOOP
    v_role_sql := CASE
      WHEN v_grantee = 0::oid THEN 'PUBLIC'
      ELSE pg_catalog.format(
        '%I',
        (SELECT role_row.rolname FROM pg_catalog.pg_roles AS role_row
         WHERE role_row.oid = v_grantee)
      )
    END;

    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON TABLE public.trader_authorizations FROM %s',
      v_role_sql
    );
  END LOOP;
END
$revoke_non_owner_table_acl$;

DO $revoke_column_privileges$
DECLARE
  v_column_list text;
  v_grantee oid;
  v_role_sql text;
BEGIN
  SELECT pg_catalog.string_agg(
    pg_catalog.format('%I', attribute.attname),
    ', '
    ORDER BY attribute.attnum
  )
  INTO v_column_list
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.trader_authorizations'::regclass
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;

  IF v_column_list IS NULL THEN
    RAISE EXCEPTION 'public.trader_authorizations has no columns to secure';
  END IF;

  EXECUTE pg_catalog.format(
    'REVOKE SELECT (%1$s), INSERT (%1$s), UPDATE (%1$s), REFERENCES (%1$s) '
      || 'ON TABLE public.trader_authorizations '
      || 'FROM PUBLIC, anon, authenticated, service_role',
    v_column_list
  );

  FOR v_grantee IN
    SELECT DISTINCT acl_entry.grantee
    FROM pg_catalog.pg_attribute AS attribute
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl_entry
    JOIN pg_catalog.pg_class AS relation
      ON relation.oid = attribute.attrelid
    WHERE attribute.attrelid = 'public.trader_authorizations'::regclass
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND acl_entry.grantee <> relation.relowner
  LOOP
    v_role_sql := CASE
      WHEN v_grantee = 0::oid THEN 'PUBLIC'
      ELSE pg_catalog.format(
        '%I',
        (SELECT role_row.rolname FROM pg_catalog.pg_roles AS role_row
         WHERE role_row.oid = v_grantee)
      )
    END;

    EXECUTE pg_catalog.format(
      'REVOKE SELECT (%1$s), INSERT (%1$s), UPDATE (%1$s), REFERENCES (%1$s) '
        || 'ON TABLE public.trader_authorizations FROM %2$s',
      v_column_list,
      v_role_sql
    );
  END LOOP;
END
$revoke_column_privileges$;

-- Drop every live policy name, including out-of-band dashboard drift, then
-- rebuild the single server policy.
DO $drop_trader_authorization_policies$
DECLARE
  v_policy_name name;
BEGIN
  FOR v_policy_name IN
    SELECT policy.polname
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.trader_authorizations'::regclass
    ORDER BY policy.polname
  LOOP
    EXECUTE pg_catalog.format(
      'DROP POLICY %I ON public.trader_authorizations',
      v_policy_name
    );
  END LOOP;
END
$drop_trader_authorization_policies$;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.trader_authorizations
  TO service_role;

-- service_role currently bypasses RLS in Supabase. Keep an explicit policy so
-- the contract remains functional if that role property changes.
CREATE POLICY "Service role manages trader authorizations"
  ON public.trader_authorizations
  AS PERMISSIVE
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Project the two credential records in one database transaction after the
-- application has completed an exchange-authoritative read-only validation.
-- The connection row is written first to match claim activation's lock order.
-- An exception from either upsert aborts the whole RPC statement, so an active
-- authorization can never survive a failed connection write (or vice versa).
CREATE OR REPLACE FUNCTION public.bind_trader_account_connection_v1(
  p_user_id uuid,
  p_platform text,
  p_trader_id text,
  p_encrypted_api_key text,
  p_encrypted_api_secret text,
  p_encrypted_passphrase text,
  p_permissions jsonb,
  p_verified_at timestamptz,
  p_label text,
  p_sync_frequency text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_platform text := pg_catalog.lower(pg_catalog.btrim(p_platform));
  v_connection_exchange text;
  v_trader_id text := pg_catalog.btrim(p_trader_id);
  v_label text := NULLIF(pg_catalog.btrim(p_label), '');
  v_sync_frequency text := pg_catalog.lower(pg_catalog.btrim(p_sync_frequency));
  v_now timestamptz := pg_catalog.statement_timestamp();
  v_authorization_id uuid;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'user id is required for account binding';
  END IF;

  v_connection_exchange := CASE
    WHEN v_platform IN ('binance', 'binance_futures', 'binance_spot')
      THEN 'binance'
    WHEN v_platform IN ('bybit', 'bybit_spot')
      THEN 'bybit'
    WHEN v_platform IN ('okx', 'okx_futures', 'okx_spot')
      THEN 'okx'
    WHEN v_platform IN ('bitget', 'bitget_futures', 'bitget_spot')
      THEN 'bitget'
    ELSE NULL
  END;

  IF v_connection_exchange IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'unsupported account-binding platform';
  END IF;

  IF v_trader_id IS NULL
     OR v_trader_id = ''
     OR pg_catalog.char_length(v_trader_id) > 512 THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'invalid exchange account id';
  END IF;

  IF p_encrypted_api_key IS NULL
     OR pg_catalog.btrim(p_encrypted_api_key) = ''
     OR pg_catalog.char_length(p_encrypted_api_key) > 65536
     OR p_encrypted_api_secret IS NULL
     OR pg_catalog.btrim(p_encrypted_api_secret) = ''
     OR pg_catalog.char_length(p_encrypted_api_secret) > 65536
     OR (
       p_encrypted_passphrase IS NOT NULL
       AND (
         pg_catalog.btrim(p_encrypted_passphrase) = ''
         OR pg_catalog.char_length(p_encrypted_passphrase) > 65536
       )
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'invalid encrypted account credential';
  END IF;

  IF v_connection_exchange IN ('okx', 'bitget')
     AND p_encrypted_passphrase IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'encrypted passphrase is required for this exchange';
  END IF;

  IF p_permissions IS NULL
     OR pg_catalog.jsonb_typeof(p_permissions) <> 'array' THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'verified read-only permissions must be a nonempty JSON array';
  END IF;

  IF pg_catalog.jsonb_array_length(p_permissions) = 0
     OR pg_catalog.jsonb_array_length(p_permissions) > 64 THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'verified read-only permissions must be a nonempty JSON array';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(p_permissions) AS permission(value)
    WHERE pg_catalog.jsonb_typeof(permission.value) <> 'string'
       OR pg_catalog.btrim(permission.value #>> '{}') = ''
       OR pg_catalog.char_length(permission.value #>> '{}') > 256
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'verified read-only permissions contain an invalid value';
  END IF;

  IF p_verified_at IS NULL
     OR p_verified_at < v_now - pg_catalog.make_interval(mins => 15)
     OR p_verified_at > v_now + pg_catalog.make_interval(mins => 5) THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'exchange validation timestamp is outside the binding window';
  END IF;

  IF p_label IS NOT NULL AND pg_catalog.char_length(p_label) > 120 THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'account binding label is too long';
  END IF;

  IF v_sync_frequency IS NULL
     OR v_sync_frequency NOT IN ('realtime', '5min', '15min', '1hour') THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'unsupported account sync frequency';
  END IF;

  -- Serialize every mutation for one canonical exchange. Row locks alone are
  -- insufficient when the connection row does not exist yet; the advisory key
  -- closes that insert-vs-revoke race while preserving connection ->
  -- authorization lock order everywhere in this control plane.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'trader-account:' || p_user_id::text || ':' || v_connection_exchange,
      0
    )
  );

  PERFORM 1
  FROM public.user_exchange_connections AS connection
  WHERE connection.user_id = p_user_id
    AND CASE
      WHEN pg_catalog.lower(pg_catalog.btrim(connection.exchange))
             IN ('binance', 'binance_futures', 'binance_spot') THEN 'binance'
      WHEN pg_catalog.lower(pg_catalog.btrim(connection.exchange))
             IN ('bybit', 'bybit_spot') THEN 'bybit'
      WHEN pg_catalog.lower(pg_catalog.btrim(connection.exchange))
             IN ('okx', 'okx_futures', 'okx_spot') THEN 'okx'
      WHEN pg_catalog.lower(pg_catalog.btrim(connection.exchange))
             IN ('bitget', 'bitget_futures', 'bitget_spot') THEN 'bitget'
      ELSE NULL
    END = v_connection_exchange
  ORDER BY connection.id
  FOR UPDATE;

  PERFORM 1
  FROM public.trader_authorizations AS auth_row
  WHERE auth_row.user_id = p_user_id
    AND CASE
      WHEN pg_catalog.lower(pg_catalog.btrim(auth_row.platform))
             IN ('binance', 'binance_futures', 'binance_spot') THEN 'binance'
      WHEN pg_catalog.lower(pg_catalog.btrim(auth_row.platform))
             IN ('bybit', 'bybit_spot') THEN 'bybit'
      WHEN pg_catalog.lower(pg_catalog.btrim(auth_row.platform))
             IN ('okx', 'okx_futures', 'okx_spot') THEN 'okx'
      WHEN pg_catalog.lower(pg_catalog.btrim(auth_row.platform))
             IN ('bitget', 'bitget_futures', 'bitget_spot') THEN 'bitget'
      ELSE NULL
    END = v_connection_exchange
  ORDER BY auth_row.id
  FOR UPDATE;

  -- user_exchange_connections has one row per canonical exchange, so a new
  -- account UID or product variant supersedes every other active authorization
  -- for that exchange. Leaving an old row active would retain a second live
  -- credential after a rotation even though the connection projection moved.
  UPDATE public.trader_authorizations AS auth_row
  SET status = 'revoked',
      verification_error = 'Superseded by a newer account binding for this exchange',
      updated_at = v_now
  WHERE auth_row.user_id = p_user_id
    AND auth_row.status = 'active'
    AND CASE
      WHEN pg_catalog.lower(pg_catalog.btrim(auth_row.platform))
             IN ('binance', 'binance_futures', 'binance_spot') THEN 'binance'
      WHEN pg_catalog.lower(pg_catalog.btrim(auth_row.platform))
             IN ('bybit', 'bybit_spot') THEN 'bybit'
      WHEN pg_catalog.lower(pg_catalog.btrim(auth_row.platform))
             IN ('okx', 'okx_futures', 'okx_spot') THEN 'okx'
      WHEN pg_catalog.lower(pg_catalog.btrim(auth_row.platform))
             IN ('bitget', 'bitget_futures', 'bitget_spot') THEN 'bitget'
      ELSE NULL
    END = v_connection_exchange
    AND NOT (
      pg_catalog.lower(pg_catalog.btrim(auth_row.platform)) = v_platform
      AND auth_row.trader_id = v_trader_id
    );

  -- A pre-cutover binder may have left an alias-key connection beside the
  -- canonical row. Keep the audit record but ensure only the canonical row
  -- written below can be active for this exchange family.
  UPDATE public.user_exchange_connections AS connection
  SET is_active = false,
      updated_at = v_now
  WHERE connection.user_id = p_user_id
    AND CASE
      WHEN pg_catalog.lower(pg_catalog.btrim(connection.exchange))
             IN ('binance', 'binance_futures', 'binance_spot') THEN 'binance'
      WHEN pg_catalog.lower(pg_catalog.btrim(connection.exchange))
             IN ('bybit', 'bybit_spot') THEN 'bybit'
      WHEN pg_catalog.lower(pg_catalog.btrim(connection.exchange))
             IN ('okx', 'okx_futures', 'okx_spot') THEN 'okx'
      WHEN pg_catalog.lower(pg_catalog.btrim(connection.exchange))
             IN ('bitget', 'bitget_futures', 'bitget_spot') THEN 'bitget'
      ELSE NULL
    END = v_connection_exchange
    AND connection.exchange <> v_connection_exchange;

  INSERT INTO public.user_exchange_connections AS connection (
    user_id,
    exchange,
    api_key_encrypted,
    api_secret_encrypted,
    passphrase_encrypted,
    is_active,
    verified_uid,
    last_verified_at,
    scope_permissions,
    updated_at
  ) VALUES (
    p_user_id,
    v_connection_exchange,
    p_encrypted_api_key,
    p_encrypted_api_secret,
    p_encrypted_passphrase,
    true,
    v_trader_id,
    p_verified_at,
    p_permissions,
    v_now
  )
  ON CONFLICT (user_id, exchange) DO UPDATE
  SET api_key_encrypted = EXCLUDED.api_key_encrypted,
      api_secret_encrypted = EXCLUDED.api_secret_encrypted,
      passphrase_encrypted = EXCLUDED.passphrase_encrypted,
      is_active = true,
      verified_uid = EXCLUDED.verified_uid,
      last_verified_at = EXCLUDED.last_verified_at,
      scope_permissions = EXCLUDED.scope_permissions,
      updated_at = EXCLUDED.updated_at;

  INSERT INTO public.trader_authorizations AS existing_authorization (
    user_id,
    platform,
    trader_id,
    encrypted_api_key,
    encrypted_api_secret,
    encrypted_passphrase,
    permissions,
    read_only_verified_at,
    status,
    last_verified_at,
    last_sync_at,
    last_sync_status,
    consecutive_failures,
    verification_error,
    label,
    sync_frequency,
    updated_at
  ) VALUES (
    p_user_id,
    v_platform,
    v_trader_id,
    p_encrypted_api_key,
    p_encrypted_api_secret,
    p_encrypted_passphrase,
    p_permissions,
    p_verified_at,
    'active',
    p_verified_at,
    NULL,
    'pending',
    0,
    NULL,
    v_label,
    v_sync_frequency,
    v_now
  )
  ON CONFLICT (user_id, platform, trader_id) DO UPDATE
  SET encrypted_api_key = EXCLUDED.encrypted_api_key,
      encrypted_api_secret = EXCLUDED.encrypted_api_secret,
      encrypted_passphrase = EXCLUDED.encrypted_passphrase,
      permissions = EXCLUDED.permissions,
      read_only_verified_at = EXCLUDED.read_only_verified_at,
      status = 'active',
      last_verified_at = EXCLUDED.last_verified_at,
      last_sync_at = NULL,
      last_sync_status = 'pending',
      consecutive_failures = 0,
      verification_error = NULL,
      label = CASE
        WHEN p_label IS NULL THEN existing_authorization.label
        ELSE EXCLUDED.label
      END,
      sync_frequency = EXCLUDED.sync_frequency,
      updated_at = EXCLUDED.updated_at
  RETURNING existing_authorization.id INTO v_authorization_id;

  RETURN v_authorization_id;
END;
$function$;

ALTER FUNCTION public.bind_trader_account_connection_v1(
  uuid,
  text,
  text,
  text,
  text,
  text,
  jsonb,
  timestamptz,
  text,
  text
) OWNER TO CURRENT_USER;

REVOKE ALL ON FUNCTION public.bind_trader_account_connection_v1(
  uuid,
  text,
  text,
  text,
  text,
  text,
  jsonb,
  timestamptz,
  text,
  text
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.bind_trader_account_connection_v1(
  uuid,
  text,
  text,
  text,
  text,
  text,
  jsonb,
  timestamptz,
  text,
  text
) TO service_role;

COMMENT ON FUNCTION public.bind_trader_account_connection_v1(
  uuid,
  text,
  text,
  text,
  text,
  text,
  jsonb,
  timestamptz,
  text,
  text
) IS
  'Service-only atomic account connection projection after exchange-authoritative read-only validation; supersedes old credentials for the canonical exchange and never proves a trader-profile claim.';

-- Revoke one canonical exchange lifecycle in a single transaction. Callers may
-- identify it either by an owned authorization UUID or by its connection key;
-- exactly one selector is required. Because one connection row is shared by
-- all product variants, revoking any member closes every authorization for that
-- canonical exchange instead of leaving another credential consumer active.
CREATE OR REPLACE FUNCTION public.revoke_trader_account_connection_v1(
  p_user_id uuid,
  p_authorization_id uuid,
  p_exchange text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_exchange text := pg_catalog.lower(pg_catalog.btrim(p_exchange));
  v_platform text;
  v_connection_found boolean := false;
  v_authorization_found boolean := false;
  v_now timestamptz := pg_catalog.statement_timestamp();
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'user id is required for account revocation';
  END IF;

  IF (p_authorization_id IS NULL) = (NULLIF(v_exchange, '') IS NULL) THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'exactly one account revocation selector is required';
  END IF;

  IF p_authorization_id IS NOT NULL THEN
    SELECT pg_catalog.lower(pg_catalog.btrim(auth_row.platform))
    INTO v_platform
    FROM public.trader_authorizations AS auth_row
    WHERE auth_row.id = p_authorization_id
      AND auth_row.user_id = p_user_id;

    IF NOT FOUND THEN
      RETURN false;
    END IF;

    v_exchange := CASE
      WHEN v_platform IN ('binance', 'binance_futures', 'binance_spot') THEN 'binance'
      WHEN v_platform IN ('bybit', 'bybit_spot') THEN 'bybit'
      WHEN v_platform IN ('okx', 'okx_futures', 'okx_spot') THEN 'okx'
      WHEN v_platform IN ('bitget', 'bitget_futures', 'bitget_spot') THEN 'bitget'
      WHEN v_platform IN ('mexc', 'htx', 'weex', 'coinex')
        THEN v_platform
      ELSE NULL
    END;

    IF v_exchange IS NULL THEN
      RETURN false;
    END IF;
  ELSE
    v_exchange := CASE
      WHEN v_exchange IN ('binance', 'binance_futures', 'binance_spot') THEN 'binance'
      WHEN v_exchange IN ('bybit', 'bybit_spot') THEN 'bybit'
      WHEN v_exchange IN ('okx', 'okx_futures', 'okx_spot') THEN 'okx'
      WHEN v_exchange IN ('bitget', 'bitget_futures', 'bitget_spot') THEN 'bitget'
      WHEN v_exchange IN ('mexc', 'htx', 'weex', 'coinex')
        THEN v_exchange
      ELSE NULL
    END;

    IF v_exchange IS NULL THEN
      RETURN false;
    END IF;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'trader-account:' || p_user_id::text || ':' || v_exchange,
      0
    )
  );

  -- Fixed lock order shared with bind_trader_account_connection_v1:
  -- connection first, authorization second.
  PERFORM 1
  FROM public.user_exchange_connections AS connection
  WHERE connection.user_id = p_user_id
    AND CASE
      WHEN pg_catalog.lower(pg_catalog.btrim(connection.exchange))
             IN ('binance', 'binance_futures', 'binance_spot') THEN 'binance'
      WHEN pg_catalog.lower(pg_catalog.btrim(connection.exchange))
             IN ('bybit', 'bybit_spot') THEN 'bybit'
      WHEN pg_catalog.lower(pg_catalog.btrim(connection.exchange))
             IN ('okx', 'okx_futures', 'okx_spot') THEN 'okx'
      WHEN pg_catalog.lower(pg_catalog.btrim(connection.exchange))
             IN ('bitget', 'bitget_futures', 'bitget_spot') THEN 'bitget'
      WHEN pg_catalog.lower(pg_catalog.btrim(connection.exchange))
             IN ('mexc', 'htx', 'weex', 'coinex')
        THEN pg_catalog.lower(pg_catalog.btrim(connection.exchange))
      ELSE NULL
    END = v_exchange
  ORDER BY connection.id
  FOR UPDATE;
  v_connection_found := FOUND;

  PERFORM 1
  FROM public.trader_authorizations AS auth_row
  WHERE auth_row.user_id = p_user_id
    AND CASE
      WHEN pg_catalog.lower(pg_catalog.btrim(auth_row.platform))
             IN ('binance', 'binance_futures', 'binance_spot') THEN 'binance'
      WHEN pg_catalog.lower(pg_catalog.btrim(auth_row.platform))
             IN ('bybit', 'bybit_spot') THEN 'bybit'
      WHEN pg_catalog.lower(pg_catalog.btrim(auth_row.platform))
             IN ('okx', 'okx_futures', 'okx_spot') THEN 'okx'
      WHEN pg_catalog.lower(pg_catalog.btrim(auth_row.platform))
             IN ('bitget', 'bitget_futures', 'bitget_spot') THEN 'bitget'
      WHEN pg_catalog.lower(pg_catalog.btrim(auth_row.platform))
             IN ('mexc', 'htx', 'weex', 'coinex')
        THEN pg_catalog.lower(pg_catalog.btrim(auth_row.platform))
      ELSE NULL
    END = v_exchange
  ORDER BY auth_row.id
  FOR UPDATE;
  v_authorization_found := FOUND;

  IF p_authorization_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM public.trader_authorizations AS auth_row
    WHERE auth_row.id = p_authorization_id
      AND auth_row.user_id = p_user_id
      AND CASE
        WHEN pg_catalog.lower(pg_catalog.btrim(auth_row.platform))
               IN ('binance', 'binance_futures', 'binance_spot') THEN 'binance'
        WHEN pg_catalog.lower(pg_catalog.btrim(auth_row.platform))
               IN ('bybit', 'bybit_spot') THEN 'bybit'
        WHEN pg_catalog.lower(pg_catalog.btrim(auth_row.platform))
               IN ('okx', 'okx_futures', 'okx_spot') THEN 'okx'
        WHEN pg_catalog.lower(pg_catalog.btrim(auth_row.platform))
               IN ('bitget', 'bitget_futures', 'bitget_spot') THEN 'bitget'
        WHEN pg_catalog.lower(pg_catalog.btrim(auth_row.platform))
               IN ('mexc', 'htx', 'weex', 'coinex')
          THEN pg_catalog.lower(pg_catalog.btrim(auth_row.platform))
        ELSE NULL
      END = v_exchange
  ) THEN
    RETURN false;
  END IF;

  IF NOT v_connection_found AND NOT v_authorization_found THEN
    RETURN false;
  END IF;

  UPDATE public.user_exchange_connections AS connection
  SET is_active = false,
      updated_at = v_now
  WHERE connection.user_id = p_user_id
    AND CASE
      WHEN pg_catalog.lower(pg_catalog.btrim(connection.exchange))
             IN ('binance', 'binance_futures', 'binance_spot') THEN 'binance'
      WHEN pg_catalog.lower(pg_catalog.btrim(connection.exchange))
             IN ('bybit', 'bybit_spot') THEN 'bybit'
      WHEN pg_catalog.lower(pg_catalog.btrim(connection.exchange))
             IN ('okx', 'okx_futures', 'okx_spot') THEN 'okx'
      WHEN pg_catalog.lower(pg_catalog.btrim(connection.exchange))
             IN ('bitget', 'bitget_futures', 'bitget_spot') THEN 'bitget'
      WHEN pg_catalog.lower(pg_catalog.btrim(connection.exchange))
             IN ('mexc', 'htx', 'weex', 'coinex')
        THEN pg_catalog.lower(pg_catalog.btrim(connection.exchange))
      ELSE NULL
    END = v_exchange;

  UPDATE public.trader_authorizations AS auth_row
  SET status = 'revoked',
      verification_error = CASE
        WHEN auth_row.status = 'revoked' THEN auth_row.verification_error
        ELSE 'Revoked by account owner'
      END,
      updated_at = v_now
  WHERE auth_row.user_id = p_user_id
    AND CASE
      WHEN pg_catalog.lower(pg_catalog.btrim(auth_row.platform))
             IN ('binance', 'binance_futures', 'binance_spot') THEN 'binance'
      WHEN pg_catalog.lower(pg_catalog.btrim(auth_row.platform))
             IN ('bybit', 'bybit_spot') THEN 'bybit'
      WHEN pg_catalog.lower(pg_catalog.btrim(auth_row.platform))
             IN ('okx', 'okx_futures', 'okx_spot') THEN 'okx'
      WHEN pg_catalog.lower(pg_catalog.btrim(auth_row.platform))
             IN ('bitget', 'bitget_futures', 'bitget_spot') THEN 'bitget'
      WHEN pg_catalog.lower(pg_catalog.btrim(auth_row.platform))
             IN ('mexc', 'htx', 'weex', 'coinex')
        THEN pg_catalog.lower(pg_catalog.btrim(auth_row.platform))
      ELSE NULL
    END = v_exchange;

  RETURN true;
END;
$function$;

ALTER FUNCTION public.revoke_trader_account_connection_v1(
  uuid,
  uuid,
  text
) OWNER TO CURRENT_USER;

REVOKE ALL ON FUNCTION public.revoke_trader_account_connection_v1(
  uuid,
  uuid,
  text
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.revoke_trader_account_connection_v1(
  uuid,
  uuid,
  text
) TO service_role;

COMMENT ON FUNCTION public.revoke_trader_account_connection_v1(
  uuid,
  uuid,
  text
) IS
  'Service-only atomic account lifecycle revocation; deactivates the canonical connection and every matching authorization in connection-to-authorization lock order.';

-- An active authorization is a credential consumer, so it may only be
-- created after the exact canonical connection projection exists. This
-- immediate check deliberately makes the retired authorization-first writers
-- fail at their first statement. The shared account advisory key prevents a
-- concurrent connection mutation from invalidating this snapshot check. The
-- binder already acquires advisory -> connection -> authorization locks.
CREATE OR REPLACE FUNCTION public.guard_trader_authorization_v1_contract()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_canonical_exchange text;
  v_connection_id uuid;
BEGIN
  IF pg_catalog.jsonb_typeof(NEW.permissions) = 'array'
     AND EXISTS (
       SELECT 1
       FROM pg_catalog.jsonb_array_elements_text(NEW.permissions)
         AS permission(value)
       WHERE pg_catalog.lower(permission.value) = 'wallet_owner'
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'wallet_owner trader authorization is retired; use the reviewed claim flow';
  END IF;

  IF NEW.encrypted_api_key LIKE 'wallet:%'
     OR NEW.encrypted_api_secret LIKE 'signature_verified:%' THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'retired bind-wallet pseudo-credentials are forbidden';
  END IF;

  -- Operational sync bookkeeping includes status in its SET list even when
  -- status remains active. Avoid account serialization unless identity or
  -- credential-attestation material actually changes.
  IF TG_OP = 'UPDATE'
     AND OLD.status = 'active'
     AND NEW.status = 'active'
     AND NEW.last_verified_at IS NOT DISTINCT FROM OLD.last_verified_at
     AND NEW.user_id IS NOT DISTINCT FROM OLD.user_id
     AND NEW.platform IS NOT DISTINCT FROM OLD.platform
     AND NEW.trader_id IS NOT DISTINCT FROM OLD.trader_id
     AND NEW.encrypted_api_key IS NOT DISTINCT FROM OLD.encrypted_api_key
     AND NEW.encrypted_api_secret IS NOT DISTINCT FROM OLD.encrypted_api_secret
     AND NEW.encrypted_passphrase IS NOT DISTINCT FROM OLD.encrypted_passphrase
     AND NEW.permissions IS NOT DISTINCT FROM OLD.permissions
     AND NEW.read_only_verified_at IS NOT DISTINCT FROM OLD.read_only_verified_at
  THEN
    RETURN NEW;
  END IF;

  IF NEW.status <> 'active' THEN
    RETURN NEW;
  END IF;

  v_canonical_exchange := CASE
    WHEN NEW.platform IN ('binance', 'binance_futures', 'binance_spot')
      THEN 'binance'
    WHEN NEW.platform IN ('bybit', 'bybit_spot') THEN 'bybit'
    WHEN NEW.platform IN ('okx', 'okx_futures', 'okx_spot') THEN 'okx'
    WHEN NEW.platform IN ('bitget', 'bitget_futures', 'bitget_spot')
      THEN 'bitget'
    ELSE NULL
  END;

  IF v_canonical_exchange IS NULL
     OR NEW.read_only_verified_at IS NULL
     OR NEW.last_verified_at IS NULL
     OR NEW.read_only_verified_at
          > pg_catalog.statement_timestamp() + pg_catalog.make_interval(mins => 5)
     OR NEW.last_verified_at IS DISTINCT FROM NEW.read_only_verified_at
     OR pg_catalog.btrim(NEW.encrypted_api_key) = ''
     OR pg_catalog.btrim(NEW.encrypted_api_secret) = ''
     OR pg_catalog.jsonb_typeof(NEW.permissions) <> 'array'
     OR pg_catalog.jsonb_array_length(NEW.permissions) = 0
     OR (
       v_canonical_exchange IN ('okx', 'bitget')
       AND (
         NEW.encrypted_passphrase IS NULL
         OR pg_catalog.btrim(NEW.encrypted_passphrase) = ''
       )
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'active trader authorization requires current read-only credential attestation';
  END IF;

  -- UPDATE triggers run after PostgreSQL has selected/locked the authorization
  -- row. Never wait for the account lock here: a concurrent canonical writer
  -- already owns it before taking connection -> authorization locks. Failing
  -- immediately avoids lock inversion while retiring auth-first writers.
  IF NOT pg_catalog.pg_try_advisory_xact_lock(
       pg_catalog.hashtextextended(
         'trader-account:' || NEW.user_id::text || ':' || v_canonical_exchange,
         0
       )
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'account authorization changed concurrently; retry through the atomic binder';
  END IF;

  SELECT connection.id
  INTO v_connection_id
  FROM public.user_exchange_connections AS connection
  WHERE connection.user_id = NEW.user_id
    AND connection.exchange = v_canonical_exchange
    AND connection.verified_uid = NEW.trader_id
    AND connection.is_active IS TRUE
    AND connection.api_key_encrypted = NEW.encrypted_api_key
    AND connection.api_secret_encrypted = NEW.encrypted_api_secret
    AND connection.passphrase_encrypted
          IS NOT DISTINCT FROM NEW.encrypted_passphrase
    AND connection.scope_permissions IS NOT DISTINCT FROM NEW.permissions
    AND connection.last_verified_at
          IS NOT DISTINCT FROM NEW.read_only_verified_at
    AND connection.last_verified_at
          IS NOT DISTINCT FROM NEW.last_verified_at;

  IF v_connection_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'active trader authorization requires one exact active canonical account connection';
  END IF;

  RETURN NEW;
END;
$function$;

ALTER FUNCTION public.guard_trader_authorization_v1_contract()
  OWNER TO CURRENT_USER;

DROP TRIGGER IF EXISTS trader_authorization_v1_contract_guard
  ON public.trader_authorizations;
CREATE TRIGGER trader_authorization_v1_contract_guard
  BEFORE INSERT OR UPDATE ON public.trader_authorizations
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_trader_authorization_v1_contract();

-- Official account RPCs already own this advisory key before acquiring the
-- connection row. Direct table writers reach this trigger after PostgreSQL
-- has selected that row, so they may only try (never wait for) the same key.
-- The account identity itself is immutable outside the canonical upsert key.
CREATE OR REPLACE FUNCTION public.serialize_exchange_connection_v1_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_user_id uuid;
  v_exchange text;
BEGIN
  IF TG_OP = 'UPDATE'
     AND (
       NEW.user_id IS DISTINCT FROM OLD.user_id
       OR NEW.exchange IS DISTINCT FROM OLD.exchange
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'account connection identity is immutable';
  END IF;

  IF TG_OP = 'DELETE' THEN
    v_user_id := OLD.user_id;
    v_exchange := pg_catalog.lower(pg_catalog.btrim(OLD.exchange));
  ELSE
    v_user_id := NEW.user_id;
    v_exchange := pg_catalog.lower(pg_catalog.btrim(NEW.exchange));
  END IF;

  v_exchange := CASE
    WHEN v_exchange IN ('binance', 'binance_futures', 'binance_spot')
      THEN 'binance'
    WHEN v_exchange IN ('bybit', 'bybit_spot') THEN 'bybit'
    WHEN v_exchange IN ('okx', 'okx_futures', 'okx_spot') THEN 'okx'
    WHEN v_exchange IN ('bitget', 'bitget_futures', 'bitget_spot')
      THEN 'bitget'
    ELSE NULL
  END;

  IF v_exchange IS NOT NULL
     AND NOT pg_catalog.pg_try_advisory_xact_lock(
       pg_catalog.hashtextextended(
         'trader-account:' || v_user_id::text || ':' || v_exchange,
         0
       )
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'account connection changed concurrently; retry through the atomic lifecycle RPC';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$function$;

ALTER FUNCTION public.serialize_exchange_connection_v1_mutation()
  OWNER TO CURRENT_USER;

DROP TRIGGER IF EXISTS exchange_connection_v1_mutation_serializer
  ON public.user_exchange_connections;
CREATE TRIGGER exchange_connection_v1_mutation_serializer
  BEFORE INSERT OR UPDATE OR DELETE ON public.user_exchange_connections
  FOR EACH ROW
  EXECUTE FUNCTION public.serialize_exchange_connection_v1_mutation();

-- A connection-first transaction may legitimately update the connection and
-- then its authorization. Check the reverse edge at transaction end so that
-- atomic bind/revoke continues to work while a standalone connection
-- mutation can never commit an orphaned or credential-divergent consumer.
CREATE OR REPLACE FUNCTION public.guard_exchange_connection_authorization_v1_contract()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_old_user_id uuid;
  v_old_exchange text;
  v_new_user_id uuid;
  v_new_exchange text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    v_old_user_id := OLD.user_id;
    v_old_exchange := OLD.exchange;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    v_new_user_id := NEW.user_id;
    v_new_exchange := NEW.exchange;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      SELECT
        auth_row.user_id,
        auth_row.trader_id,
        auth_row.encrypted_api_key,
        auth_row.encrypted_api_secret,
        auth_row.encrypted_passphrase,
        auth_row.permissions,
        auth_row.read_only_verified_at,
        auth_row.last_verified_at,
        CASE
          WHEN auth_row.platform
                 IN ('binance', 'binance_futures', 'binance_spot')
            THEN 'binance'
          WHEN auth_row.platform IN ('bybit', 'bybit_spot') THEN 'bybit'
          WHEN auth_row.platform IN ('okx', 'okx_futures', 'okx_spot')
            THEN 'okx'
          WHEN auth_row.platform
                 IN ('bitget', 'bitget_futures', 'bitget_spot')
            THEN 'bitget'
          ELSE NULL
        END AS canonical_exchange
      FROM public.trader_authorizations AS auth_row
      WHERE auth_row.status = 'active'
    ) AS candidate
    WHERE (
      (
        v_old_user_id IS NOT NULL
        AND candidate.user_id = v_old_user_id
        AND candidate.canonical_exchange = v_old_exchange
      ) OR (
        v_new_user_id IS NOT NULL
        AND candidate.user_id = v_new_user_id
        AND candidate.canonical_exchange = v_new_exchange
      )
    )
      AND NOT EXISTS (
        SELECT 1
        FROM public.user_exchange_connections AS connection
        WHERE connection.user_id = candidate.user_id
          AND connection.exchange = candidate.canonical_exchange
          AND connection.verified_uid = candidate.trader_id
          AND connection.is_active IS TRUE
          AND connection.api_key_encrypted = candidate.encrypted_api_key
          AND connection.api_secret_encrypted = candidate.encrypted_api_secret
          AND connection.passphrase_encrypted
                IS NOT DISTINCT FROM candidate.encrypted_passphrase
          AND connection.scope_permissions
                IS NOT DISTINCT FROM candidate.permissions
          AND connection.last_verified_at
                IS NOT DISTINCT FROM candidate.read_only_verified_at
          AND connection.last_verified_at
                IS NOT DISTINCT FROM candidate.last_verified_at
      )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'account connection mutation would orphan an active trader authorization';
  END IF;

  RETURN NULL;
END;
$function$;

ALTER FUNCTION public.guard_exchange_connection_authorization_v1_contract()
  OWNER TO CURRENT_USER;

DROP TRIGGER IF EXISTS exchange_connection_authorization_v1_contract_guard
  ON public.user_exchange_connections;
CREATE CONSTRAINT TRIGGER exchange_connection_authorization_v1_contract_guard
  AFTER INSERT OR UPDATE OR DELETE ON public.user_exchange_connections
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_exchange_connection_authorization_v1_contract();

REVOKE ALL ON FUNCTION public.guard_trader_authorization_v1_contract()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.serialize_exchange_connection_v1_mutation()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.guard_exchange_connection_authorization_v1_contract()
  FROM PUBLIC, anon, authenticated, service_role;

-- CREATE OR REPLACE preserves historical function ACLs. Revoke every direct
-- non-owner grant, including custom roles that are not part of Supabase's
-- standard role set, before rebuilding the two callable service capabilities.
DO $converge_function_acl$
DECLARE
  v_function record;
  v_grantee oid;
  v_role_sql text;
BEGIN
  FOR v_function IN
    SELECT
      procedure_row.oid,
      procedure_row.proowner,
      pg_catalog.format(
        '%I.%I(%s)',
        namespace_row.nspname,
        procedure_row.proname,
        pg_catalog.pg_get_function_identity_arguments(procedure_row.oid)
      ) AS qualified_signature
    FROM pg_catalog.pg_proc AS procedure_row
    JOIN pg_catalog.pg_namespace AS namespace_row
      ON namespace_row.oid = procedure_row.pronamespace
    WHERE procedure_row.oid IN (
      'public.bind_trader_account_connection_v1(uuid,text,text,text,text,text,jsonb,timestamptz,text,text)'::regprocedure,
      'public.revoke_trader_account_connection_v1(uuid,uuid,text)'::regprocedure,
      'public.guard_trader_authorization_v1_contract()'::regprocedure,
      'public.serialize_exchange_connection_v1_mutation()'::regprocedure,
      'public.guard_exchange_connection_authorization_v1_contract()'::regprocedure,
      'public.update_updated_at_column()'::regprocedure,
      'public.update_trader_authorizations_updated_at()'::regprocedure
    )
    ORDER BY procedure_row.oid
  LOOP
    FOR v_grantee IN
      SELECT DISTINCT acl_entry.grantee
      FROM pg_catalog.pg_proc AS acl_procedure
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          acl_procedure.proacl,
          pg_catalog.acldefault('f', acl_procedure.proowner)
        )
      ) AS acl_entry
      WHERE acl_procedure.oid = v_function.oid
        AND acl_entry.grantee <> v_function.proowner
    LOOP
      v_role_sql := CASE
        WHEN v_grantee = 0::oid THEN 'PUBLIC'
        ELSE pg_catalog.format(
          '%I',
          (SELECT role_row.rolname FROM pg_catalog.pg_roles AS role_row
           WHERE role_row.oid = v_grantee)
        )
      END;

      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON FUNCTION %s FROM %s',
        v_function.qualified_signature,
        v_role_sql
      );
    END LOOP;
  END LOOP;
END
$converge_function_acl$;

GRANT EXECUTE ON FUNCTION public.bind_trader_account_connection_v1(
  uuid,
  text,
  text,
  text,
  text,
  text,
  jsonb,
  timestamptz,
  text,
  text
) TO service_role;
GRANT EXECUTE ON FUNCTION public.revoke_trader_account_connection_v1(
  uuid, uuid, text
) TO service_role;

-- Fail the transaction if a browser table/column/RPC path remains,
-- service_role has excess powers, or policy drift did not converge exactly.
DO $postflight$
DECLARE
  v_relation regclass := 'public.trader_authorizations'::regclass;
  v_connection_relation regclass :=
    'public.user_exchange_connections'::regclass;
  v_binding_function regprocedure := pg_catalog.to_regprocedure(
    'public.bind_trader_account_connection_v1(uuid,text,text,text,text,text,jsonb,timestamp with time zone,text,text)'
  );
  v_revocation_function regprocedure := pg_catalog.to_regprocedure(
    'public.revoke_trader_account_connection_v1(uuid,uuid,text)'
  );
  v_authorization_guard regprocedure := pg_catalog.to_regprocedure(
    'public.guard_trader_authorization_v1_contract()'
  );
  v_connection_guard regprocedure := pg_catalog.to_regprocedure(
    'public.guard_exchange_connection_authorization_v1_contract()'
  );
  v_connection_serializer regprocedure := pg_catalog.to_regprocedure(
    'public.serialize_exchange_connection_v1_mutation()'
  );
  v_shared_timestamp_function regprocedure := pg_catalog.to_regprocedure(
    'public.update_updated_at_column()'
  );
  v_authorization_timestamp_function regprocedure := pg_catalog.to_regprocedure(
    'public.update_trader_authorizations_updated_at()'
  );
  v_role name;
  v_privilege text;
  v_column name;
  v_service_role_oid oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'service_role'
  );
BEGIN
  IF v_binding_function IS NULL THEN
    RAISE EXCEPTION 'atomic account-binding function was not installed';
  END IF;

  IF v_revocation_function IS NULL THEN
    RAISE EXCEPTION 'atomic account-revocation function was not installed';
  END IF;

  IF v_authorization_guard IS NULL
     OR v_connection_guard IS NULL
     OR v_connection_serializer IS NULL
     OR v_shared_timestamp_function IS NULL
     OR v_authorization_timestamp_function IS NULL THEN
    RAISE EXCEPTION 'continuous account-authorization guards were not installed';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS procedure_row
    WHERE procedure_row.oid IN (
      v_binding_function,
      v_revocation_function,
      v_authorization_guard,
      v_connection_guard,
      v_connection_serializer,
      v_shared_timestamp_function,
      v_authorization_timestamp_function
    )
      AND procedure_row.proowner IS DISTINCT FROM (
        SELECT relation.relowner
        FROM pg_catalog.pg_class AS relation
        WHERE relation.oid = v_relation
      )
  ) OR (
    SELECT relation.relowner
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = v_connection_relation
  ) IS DISTINCT FROM (
    SELECT relation.relowner
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = v_relation
  ) THEN
    RAISE EXCEPTION
      'account authorization function ownership contract is incorrect';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS procedure_row
    WHERE procedure_row.oid IN (
      v_shared_timestamp_function,
      v_authorization_timestamp_function
    )
      AND NOT (
        procedure_row.prokind = 'f'
        AND procedure_row.prorettype = 'trigger'::regtype
        AND NOT procedure_row.prosecdef
        AND procedure_row.proconfig =
            ARRAY['search_path=pg_catalog, pg_temp']::text[]
        AND procedure_row.prosrc = E'\nBEGIN\n  NEW.updated_at = pg_catalog.now();\n  RETURN NEW;\nEND;\n'
      )
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = v_connection_relation
      AND trigger_row.tgname =
          'trigger_user_exchange_connections_updated_at'
      AND trigger_row.tgfoid = v_shared_timestamp_function
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgenabled = 'O'
      AND trigger_row.tgtype = 19
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = v_relation
      AND trigger_row.tgname =
          'trigger_update_trader_authorizations_updated_at'
      AND trigger_row.tgfoid = v_authorization_timestamp_function
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgenabled = 'O'
      AND trigger_row.tgtype = 19
  ) THEN
    RAISE EXCEPTION 'account timestamp trigger boundary is incorrect';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS procedure_row
    WHERE procedure_row.oid = v_binding_function
      AND procedure_row.prosecdef
      AND procedure_row.prokind = 'f'
      AND procedure_row.prorettype = pg_catalog.to_regtype('uuid')
      AND procedure_row.proconfig @> ARRAY[
        'search_path=pg_catalog, pg_temp'
      ]::text[]
  ) THEN
    RAISE EXCEPTION
      'atomic account-binding function security contract is incorrect';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS procedure_row
    WHERE procedure_row.oid = v_revocation_function
      AND procedure_row.prosecdef
      AND procedure_row.prokind = 'f'
      AND procedure_row.prorettype = pg_catalog.to_regtype('boolean')
      AND procedure_row.proconfig @> ARRAY[
        'search_path=pg_catalog, pg_temp'
      ]::text[]
  ) THEN
    RAISE EXCEPTION
      'atomic account-revocation function security contract is incorrect';
  END IF;

  IF pg_catalog.has_function_privilege(
       'anon',
       v_binding_function,
       'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'authenticated',
       v_binding_function,
       'EXECUTE'
     )
     OR NOT pg_catalog.has_function_privilege(
       'service_role',
       v_binding_function,
       'EXECUTE'
     )
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS procedure_row
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(
           procedure_row.proacl,
           pg_catalog.acldefault('f', procedure_row.proowner)
         )
       ) AS acl_entry
       WHERE procedure_row.oid = v_binding_function
         AND acl_entry.grantee = 0::oid
         AND acl_entry.privilege_type = 'EXECUTE'
     ) THEN
    RAISE EXCEPTION
      'atomic account-binding function execute privileges are incorrect';
  END IF;

  IF pg_catalog.has_function_privilege(
       'anon',
       v_revocation_function,
       'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'authenticated',
       v_revocation_function,
       'EXECUTE'
     )
     OR NOT pg_catalog.has_function_privilege(
       'service_role',
       v_revocation_function,
       'EXECUTE'
     )
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS procedure_row
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(
           procedure_row.proacl,
           pg_catalog.acldefault('f', procedure_row.proowner)
         )
       ) AS acl_entry
       WHERE procedure_row.oid = v_revocation_function
         AND acl_entry.grantee = 0::oid
         AND acl_entry.privilege_type = 'EXECUTE'
     ) THEN
    RAISE EXCEPTION
      'atomic account-revocation function execute privileges are incorrect';
  END IF;

  IF pg_catalog.has_function_privilege(
       'service_role',
       v_authorization_guard,
       'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'service_role',
       v_connection_guard,
       'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'service_role',
       v_connection_serializer,
       'EXECUTE'
     )
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS procedure_row
       WHERE procedure_row.oid IN (v_authorization_guard, v_connection_guard)
         AND (
           NOT procedure_row.prosecdef
           OR NOT procedure_row.proconfig @> ARRAY[
             'search_path=pg_catalog, pg_temp'
           ]::text[]
         )
     ) OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS procedure_row
       WHERE procedure_row.oid = v_connection_serializer
         AND NOT procedure_row.prosecdef
         AND procedure_row.proconfig @> ARRAY[
           'search_path=pg_catalog, pg_temp'
         ]::text[]
     )
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_trigger AS trigger_row
       WHERE trigger_row.tgrelid = v_relation
         AND trigger_row.tgname = 'trader_authorization_v1_contract_guard'
         AND trigger_row.tgfoid = v_authorization_guard
         AND NOT trigger_row.tgisinternal
         AND trigger_row.tgenabled = 'O'
         AND trigger_row.tgtype = 23
     ) OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_trigger AS trigger_row
       WHERE trigger_row.tgrelid = 'public.user_exchange_connections'::regclass
         AND trigger_row.tgname = 'exchange_connection_v1_mutation_serializer'
         AND trigger_row.tgfoid = v_connection_serializer
         AND NOT trigger_row.tgisinternal
         AND trigger_row.tgenabled = 'O'
         AND trigger_row.tgtype = 31
     ) OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_trigger AS trigger_row
       WHERE trigger_row.tgrelid = 'public.user_exchange_connections'::regclass
         AND trigger_row.tgname =
               'exchange_connection_authorization_v1_contract_guard'
         AND trigger_row.tgfoid = v_connection_guard
         AND NOT trigger_row.tgisinternal
         AND trigger_row.tgenabled = 'O'
         AND trigger_row.tgtype = 29
         AND trigger_row.tgconstraint <> 0
         AND trigger_row.tgdeferrable
         AND trigger_row.tginitdeferred
     ) THEN
    RAISE EXCEPTION
      'continuous account-authorization guard boundary is incorrect';
  END IF;

  IF NOT (
    SELECT relation.relrowsecurity
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = v_relation
  ) THEN
    RAISE EXCEPTION
      'row level security is not enabled on public.trader_authorizations';
  END IF;

  IF NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_constraint AS constraint_row
       WHERE constraint_row.conrelid = v_relation
         AND constraint_row.conname = 'trader_authorizations_no_legacy_wallet_marker'
         AND constraint_row.contype = 'c'
         AND constraint_row.convalidated
         AND pg_catalog.pg_get_constraintdef(constraint_row.oid)
               LIKE '%wallet_owner%'
         AND pg_catalog.pg_get_constraintdef(constraint_row.oid)
               LIKE '%wallet:%'
         AND pg_catalog.pg_get_constraintdef(constraint_row.oid)
               LIKE '%signature_verified:%'
     ) OR EXISTS (
       SELECT 1
       FROM public.trader_authorizations AS auth_row
       WHERE COALESCE(auth_row.permissions, '[]'::jsonb)::text ~* '"wallet_owner"'
          OR auth_row.encrypted_api_key LIKE 'wallet:%'
          OR auth_row.encrypted_api_secret LIKE 'signature_verified:%'
     ) THEN
    RAISE EXCEPTION
      'legacy bind-wallet authorization marker boundary is incorrect';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.user_exchange_connections AS connection
    WHERE connection.is_active IS TRUE
      AND (
        connection.exchange NOT IN ('binance', 'bybit', 'okx', 'bitget')
        OR connection.verified_uid IS NULL
        OR pg_catalog.btrim(connection.verified_uid) = ''
        OR connection.last_verified_at IS NULL
        OR CASE
          WHEN pg_catalog.jsonb_typeof(connection.scope_permissions) = 'array'
            THEN pg_catalog.jsonb_array_length(connection.scope_permissions) = 0
          ELSE true
        END
        OR pg_catalog.lower(pg_catalog.btrim(connection.api_key_encrypted)) = 'oauth'
        OR pg_catalog.lower(pg_catalog.btrim(connection.api_secret_encrypted)) = 'oauth'
        OR (
          connection.exchange IN ('okx', 'bitget')
          AND (
            connection.passphrase_encrypted IS NULL
            OR pg_catalog.btrim(connection.passphrase_encrypted) = ''
          )
        )
      )
  ) THEN
    RAISE EXCEPTION
      'unattested or noncanonical active exchange connection survived quarantine';
  END IF;

  IF EXISTS (
    WITH active_authorizations AS (
      SELECT
        auth_row.id,
        auth_row.user_id,
        auth_row.trader_id,
        CASE
          WHEN auth_row.platform
                 IN ('binance', 'binance_futures', 'binance_spot') THEN 'binance'
          WHEN auth_row.platform IN ('bybit', 'bybit_spot') THEN 'bybit'
          WHEN auth_row.platform
                 IN ('okx', 'okx_futures', 'okx_spot') THEN 'okx'
          WHEN auth_row.platform
                 IN ('bitget', 'bitget_futures', 'bitget_spot') THEN 'bitget'
          ELSE NULL
        END AS canonical_exchange,
        auth_row.permissions,
        auth_row.read_only_verified_at,
        auth_row.last_verified_at,
        auth_row.encrypted_api_key,
        auth_row.encrypted_api_secret,
        auth_row.encrypted_passphrase
      FROM public.trader_authorizations AS auth_row
      WHERE auth_row.status = 'active'
    )
    SELECT 1
    FROM active_authorizations AS candidate
    WHERE candidate.canonical_exchange IS NULL
       OR candidate.read_only_verified_at IS NULL
       OR candidate.last_verified_at IS NULL
       OR pg_catalog.btrim(candidate.encrypted_api_key) = ''
       OR pg_catalog.btrim(candidate.encrypted_api_secret) = ''
       OR (
         candidate.canonical_exchange IN ('okx', 'bitget')
         AND (
           candidate.encrypted_passphrase IS NULL
           OR pg_catalog.btrim(candidate.encrypted_passphrase) = ''
         )
       )
       OR CASE
         WHEN pg_catalog.jsonb_typeof(candidate.permissions) = 'array'
           THEN pg_catalog.jsonb_array_length(candidate.permissions) = 0
         ELSE true
       END
       OR NOT EXISTS (
         SELECT 1
         FROM public.user_exchange_connections AS connection
         WHERE connection.user_id = candidate.user_id
           AND connection.exchange = candidate.canonical_exchange
           AND connection.verified_uid = candidate.trader_id
           AND connection.is_active IS TRUE
           AND connection.api_key_encrypted = candidate.encrypted_api_key
           AND connection.api_secret_encrypted = candidate.encrypted_api_secret
           AND connection.passphrase_encrypted
                 IS NOT DISTINCT FROM candidate.encrypted_passphrase
           AND connection.scope_permissions
                 IS NOT DISTINCT FROM candidate.permissions
           AND connection.last_verified_at
                 IS NOT DISTINCT FROM candidate.read_only_verified_at
       )
       OR (
         SELECT pg_catalog.count(*)
         FROM active_authorizations AS sibling
         WHERE sibling.user_id = candidate.user_id
           AND sibling.canonical_exchange = candidate.canonical_exchange
       ) <> 1
  ) THEN
    RAISE EXCEPTION
      'active authorization survived without one exact canonical connection';
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
      IF pg_catalog.has_table_privilege(v_role, v_relation, v_privilege) THEN
        RAISE EXCEPTION
          '% still has % on public.trader_authorizations',
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
            '% still has column % on public.trader_authorizations.%',
            v_role,
            v_privilege,
            v_column;
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;

  -- PUBLIC is not a row in pg_roles, so inspect relation and column ACL entries
  -- directly instead of relying on has_*_privilege helpers.
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
    RAISE EXCEPTION 'PUBLIC privileges remain on public.trader_authorizations';
  END IF;

  -- No non-owner role should retain a direct column ACL. The table-level
  -- service grant below is the only intended CRUD authority.
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl_entry
    JOIN pg_catalog.pg_class AS relation
      ON relation.oid = attribute.attrelid
    WHERE attribute.attrelid = v_relation
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND acl_entry.grantee <> relation.relowner
  ) THEN
    RAISE EXCEPTION
      'non-owner column ACL remains on public.trader_authorizations';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
    ) AS acl_entry
    WHERE relation.oid = v_relation
      AND acl_entry.grantee <> relation.relowner
      AND NOT (
        acl_entry.grantee = v_service_role_oid
        AND acl_entry.privilege_type = ANY(
          ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']::text[]
        )
        AND NOT acl_entry.is_grantable
      )
  ) OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_class AS relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
    ) AS acl_entry
    WHERE relation.oid = v_relation
      AND acl_entry.grantee = v_service_role_oid
      AND acl_entry.privilege_type = ANY(
        ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']::text[]
      )
      AND NOT acl_entry.is_grantable
  ) <> 4 THEN
    RAISE EXCEPTION
      'trader_authorizations direct table ACL inventory is not exact';
  END IF;

  IF EXISTS (
    WITH expected(proname, signature, service_callable) AS (
      VALUES
        (
          'bind_trader_account_connection_v1'::name,
          'public.bind_trader_account_connection_v1(uuid,text,text,text,text,text,jsonb,timestamptz,text,text)'::text,
          true
        ),
        (
          'revoke_trader_account_connection_v1'::name,
          'public.revoke_trader_account_connection_v1(uuid,uuid,text)'::text,
          true
        ),
        (
          'guard_trader_authorization_v1_contract'::name,
          'public.guard_trader_authorization_v1_contract()'::text,
          false
        ),
        (
          'serialize_exchange_connection_v1_mutation'::name,
          'public.serialize_exchange_connection_v1_mutation()'::text,
          false
        ),
        (
          'guard_exchange_connection_authorization_v1_contract'::name,
          'public.guard_exchange_connection_authorization_v1_contract()'::text,
          false
        ),
        (
          'update_updated_at_column'::name,
          'public.update_updated_at_column()'::text,
          false
        ),
        (
          'update_trader_authorizations_updated_at'::name,
          'public.update_trader_authorizations_updated_at()'::text,
          false
        )
    )
    SELECT 1
    FROM expected
    WHERE pg_catalog.to_regprocedure(expected.signature) IS NULL

    UNION ALL

    SELECT 1
    FROM pg_catalog.pg_proc AS procedure_row
    JOIN pg_catalog.pg_namespace AS namespace_row
      ON namespace_row.oid = procedure_row.pronamespace
    WHERE namespace_row.nspname = 'public'
      AND procedure_row.proname IN (SELECT expected.proname FROM expected)
      AND NOT EXISTS (
        SELECT 1
        FROM expected
        WHERE expected.proname = procedure_row.proname
          AND procedure_row.oid IS NOT DISTINCT FROM
                pg_catalog.to_regprocedure(expected.signature)
      )

    UNION ALL

    SELECT 1
    FROM expected
    JOIN pg_catalog.pg_proc AS procedure_row
      ON procedure_row.oid = pg_catalog.to_regprocedure(expected.signature)
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        procedure_row.proacl,
        pg_catalog.acldefault('f', procedure_row.proowner)
      )
    ) AS acl_entry
    WHERE acl_entry.grantee <> procedure_row.proowner
      AND NOT (
        expected.service_callable
        AND acl_entry.grantee = v_service_role_oid
        AND acl_entry.privilege_type = 'EXECUTE'
        AND NOT acl_entry.is_grantable
      )
  ) THEN
    RAISE EXCEPTION
      'trader-authorization overload or direct function ACL inventory is not exact';
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
        'service_role is missing % on public.trader_authorizations',
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
        'service_role unexpectedly has % on public.trader_authorizations',
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
      AND policy.polname = 'Service role manages trader authorizations'
      AND policy.polpermissive
      AND policy.polcmd = '*'
      AND policy.polroles = ARRAY[v_service_role_oid]::oid[]
      AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid) = 'true'
      AND pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid) = 'true'
  ) THEN
    RAISE EXCEPTION
      'trader authorization RLS policies did not converge to service-only ALL';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
