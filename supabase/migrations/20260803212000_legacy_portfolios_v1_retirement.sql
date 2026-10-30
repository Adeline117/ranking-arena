-- Retire the unverified legacy CEX portfolio credential plane for Arena V1.
--
-- Existing encrypted credentials are preserved for owner inventory/removal,
-- but neither browser roles nor service_role may create, update, or sync this
-- state. The application bridge must already return fixed 410 responses from
-- POST /api/portfolio and POST /api/portfolio/sync, and its snapshot cron must
-- be a compatibility no-op before this migration is applied.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended(
    'public.user_portfolios:v1-retirement',
    0
  )
);

DO $preflight$
DECLARE
  v_table_name text;
  v_missing_roles text[];
  v_missing_columns text[];
BEGIN
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
    RAISE EXCEPTION 'legacy portfolio ACL roles are missing: %', v_missing_roles;
  END IF;

  FOREACH v_table_name IN ARRAY ARRAY[
    'user_portfolios',
    'user_positions',
    'user_portfolio_snapshots'
  ]::text[]
  LOOP
    IF pg_catalog.to_regclass('public.' || v_table_name) IS NULL THEN
      RAISE EXCEPTION 'public.% must exist before V1 portfolio retirement', v_table_name;
    END IF;
  END LOOP;

  SELECT pg_catalog.array_agg(required_column ORDER BY required_column)
  INTO v_missing_columns
  FROM pg_catalog.unnest(
    ARRAY[
      'id',
      'user_id',
      'exchange',
      'api_key_encrypted',
      'api_secret_encrypted',
      'api_passphrase_encrypted'
    ]::text[]
  ) AS required_column
  WHERE NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = 'public.user_portfolios'::regclass
      AND attribute.attname = required_column
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  );

  IF v_missing_columns IS NOT NULL THEN
    RAISE EXCEPTION
      'public.user_portfolios is missing credential boundary columns: %',
      v_missing_columns;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.contype = 'f'
      AND constraint_row.conrelid = 'public.user_positions'::regclass
      AND constraint_row.confrelid = 'public.user_portfolios'::regclass
      AND constraint_row.convalidated
      AND constraint_row.confdeltype = 'c'
      AND constraint_row.conkey = ARRAY[
        (
          SELECT attribute.attnum
          FROM pg_catalog.pg_attribute AS attribute
          WHERE attribute.attrelid = 'public.user_positions'::regclass
            AND attribute.attname = 'portfolio_id'
        )
      ]::smallint[]
      AND constraint_row.confkey = ARRAY[
        (
          SELECT attribute.attnum
          FROM pg_catalog.pg_attribute AS attribute
          WHERE attribute.attrelid = 'public.user_portfolios'::regclass
            AND attribute.attname = 'id'
        )
      ]::smallint[]
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.contype = 'f'
      AND constraint_row.conrelid = 'public.user_portfolio_snapshots'::regclass
      AND constraint_row.confrelid = 'public.user_portfolios'::regclass
      AND constraint_row.convalidated
      AND constraint_row.confdeltype = 'c'
      AND constraint_row.conkey = ARRAY[
        (
          SELECT attribute.attnum
          FROM pg_catalog.pg_attribute AS attribute
          WHERE attribute.attrelid = 'public.user_portfolio_snapshots'::regclass
            AND attribute.attname = 'portfolio_id'
        )
      ]::smallint[]
      AND constraint_row.confkey = ARRAY[
        (
          SELECT attribute.attnum
          FROM pg_catalog.pg_attribute AS attribute
          WHERE attribute.attrelid = 'public.user_portfolios'::regclass
            AND attribute.attname = 'id'
        )
      ]::smallint[]
  ) THEN
    RAISE EXCEPTION
      'legacy portfolio children require validated portfolio_id -> id ON DELETE CASCADE foreign keys';
  END IF;
END
$preflight$;

LOCK TABLE
  public.user_portfolios,
  public.user_positions,
  public.user_portfolio_snapshots
  IN ACCESS EXCLUSIVE MODE;

ALTER TABLE public.user_portfolios ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_portfolio_snapshots ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE
  public.user_portfolios,
  public.user_positions,
  public.user_portfolio_snapshots
  FROM PUBLIC, anon, authenticated, service_role;

-- Converge direct grants made to dashboard/manual writer roles too. If a
-- browser role inherits from one of these parents, removing the parent grant
-- closes that path without mutating role membership.
DO $revoke_non_owner_table_acl$
DECLARE
  v_acl record;
BEGIN
  FOR v_acl IN
    SELECT DISTINCT
      relation.relname AS table_name,
      grantee_role.rolname AS grantee_name
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        relation.relacl,
        pg_catalog.acldefault('r', relation.relowner)
      )
    ) AS acl_entry
    JOIN pg_catalog.pg_roles AS grantee_role
      ON grantee_role.oid = acl_entry.grantee
    WHERE namespace.nspname = 'public'
      AND relation.relname IN (
        'user_portfolios',
        'user_positions',
        'user_portfolio_snapshots'
      )
      AND acl_entry.grantee <> relation.relowner
    ORDER BY relation.relname, grantee_role.rolname
  LOOP
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON TABLE public.%I FROM %I',
      v_acl.table_name,
      v_acl.grantee_name
    );
  END LOOP;
END
$revoke_non_owner_table_acl$;

DO $revoke_column_privileges$
DECLARE
  v_table_name text;
  v_column_list text;
BEGIN
  FOREACH v_table_name IN ARRAY ARRAY[
    'user_portfolios',
    'user_positions',
    'user_portfolio_snapshots'
  ]::text[]
  LOOP
    SELECT pg_catalog.string_agg(
      pg_catalog.format('%I', attribute.attname),
      ', '
      ORDER BY attribute.attnum
    )
    INTO v_column_list
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = pg_catalog.to_regclass('public.' || v_table_name)
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped;

    EXECUTE pg_catalog.format(
      'REVOKE SELECT (%1$s), INSERT (%1$s), UPDATE (%1$s), REFERENCES (%1$s) '
        || 'ON TABLE public.%2$I FROM PUBLIC, anon, authenticated, service_role',
      v_column_list,
      v_table_name
    );
  END LOOP;
END
$revoke_column_privileges$;

DO $revoke_non_owner_column_acl$
DECLARE
  v_acl record;
BEGIN
  FOR v_acl IN
    SELECT DISTINCT
      relation.relname AS table_name,
      attribute.attname AS column_name,
      grantee_role.rolname AS grantee_name
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
    JOIN pg_catalog.pg_attribute AS attribute
      ON attribute.attrelid = relation.oid
     AND attribute.attnum > 0
     AND NOT attribute.attisdropped
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl_entry
    JOIN pg_catalog.pg_roles AS grantee_role
      ON grantee_role.oid = acl_entry.grantee
    WHERE namespace.nspname = 'public'
      AND relation.relname IN (
        'user_portfolios',
        'user_positions',
        'user_portfolio_snapshots'
      )
      AND acl_entry.grantee <> relation.relowner
    ORDER BY relation.relname, attribute.attname, grantee_role.rolname
  LOOP
    EXECUTE pg_catalog.format(
      'REVOKE SELECT (%1$I), INSERT (%1$I), UPDATE (%1$I), REFERENCES (%1$I) '
        || 'ON TABLE public.%2$I FROM %3$I',
      v_acl.column_name,
      v_acl.table_name,
      v_acl.grantee_name
    );
  END LOOP;
END
$revoke_non_owner_column_acl$;

DO $drop_legacy_portfolio_policies$
DECLARE
  v_policy record;
BEGIN
  FOR v_policy IN
    SELECT relation.relname AS table_name, policy.polname AS policy_name
    FROM pg_catalog.pg_policy AS policy
    JOIN pg_catalog.pg_class AS relation
      ON relation.oid = policy.polrelid
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public'
      AND relation.relname IN (
        'user_portfolios',
        'user_positions',
        'user_portfolio_snapshots'
      )
    ORDER BY relation.relname, policy.polname
  LOOP
    EXECUTE pg_catalog.format(
      'DROP POLICY %I ON public.%I',
      v_policy.policy_name,
      v_policy.table_name
    );
  END LOOP;
END
$drop_legacy_portfolio_policies$;

-- The only retained mutation is an owner-filtered removal requested by the
-- authenticated server route through this narrow capability. The RPC does not
-- itself authenticate the caller's user id; service_role remains a trusted
-- bridge identity. Child rows use the preflight-proven ON DELETE CASCADE keys.
-- service_role receives no direct DELETE privilege.
CREATE OR REPLACE FUNCTION public.delete_legacy_portfolio_v1(
  p_user_id uuid,
  p_portfolio_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_found_id uuid;
BEGIN
  IF p_user_id IS NULL OR p_portfolio_id IS NULL THEN
    RAISE EXCEPTION 'user id and portfolio id are required'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'legacy-portfolio:' || p_user_id::text || ':' || p_portfolio_id::text,
      0
    )
  );

  SELECT portfolio.id
  INTO v_found_id
  FROM public.user_portfolios AS portfolio
  WHERE portfolio.id = p_portfolio_id
    AND portfolio.user_id = p_user_id
  FOR UPDATE;

  IF v_found_id IS NULL THEN
    RETURN false;
  END IF;

  DELETE FROM public.user_portfolios AS portfolio
  WHERE portfolio.id = v_found_id
    AND portfolio.user_id = p_user_id;

  RETURN FOUND;
END
$function$;

ALTER FUNCTION public.delete_legacy_portfolio_v1(uuid, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.delete_legacy_portfolio_v1(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.delete_legacy_portfolio_v1(uuid, uuid)
  TO service_role;

-- Retained portfolio rows remain part of an owner's portable data even though
-- the legacy sync product is retired. Expose the exact non-secret projection
-- through one owner-filtered capability instead of reopening direct child
-- table SELECT. All three arrays are built by one SQL statement, so they share
-- one MVCC snapshot; numeric values are text to avoid JSON precision loss.
-- Each dataset is hard-bounded at the route's 250,000-row limit plus one
-- sentinel row, allowing the runtime parser to reject oversize exports without
-- letting this aggregate allocate an unbounded result.
CREATE OR REPLACE FUNCTION public.export_legacy_portfolio_data_v1(
  p_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_portfolio_count bigint;
  v_position_count bigint;
  v_snapshot_count bigint;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'user id is required'
      USING ERRCODE = '22023';
  END IF;

  -- Reject before jsonb aggregation. The fixed limit mirrors
  -- MAX_EXPORT_ROWS_PER_DATASET in the application export contract and is not
  -- caller-controlled.
  SELECT
    (
      SELECT pg_catalog.count(*)
      FROM public.user_portfolios AS portfolio
      WHERE portfolio.user_id = p_user_id
    ),
    (
      SELECT pg_catalog.count(*)
      FROM public.user_positions AS position_row
      JOIN public.user_portfolios AS portfolio
        ON portfolio.id = position_row.portfolio_id
      WHERE portfolio.user_id = p_user_id
    ),
    (
      SELECT pg_catalog.count(*)
      FROM public.user_portfolio_snapshots AS snapshot_row
      JOIN public.user_portfolios AS portfolio
        ON portfolio.id = snapshot_row.portfolio_id
      WHERE portfolio.user_id = p_user_id
    )
  INTO v_portfolio_count, v_position_count, v_snapshot_count;

  IF v_portfolio_count > 250000
     OR v_position_count > 250000
     OR v_snapshot_count > 250000 THEN
    RAISE EXCEPTION 'legacy portfolio export exceeds the synchronous row limit'
      USING ERRCODE = '54000';
  END IF;

  RETURN (
    SELECT pg_catalog.jsonb_build_object(
      'portfolios',
      COALESCE(
        (
          SELECT pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
              'id', portfolio.id,
              'exchange', portfolio.exchange,
              'label', portfolio.label,
              'created_at', portfolio.created_at
            )
            ORDER BY portfolio.id
          )
          FROM (
            SELECT
              portfolio_row.id,
              portfolio_row.exchange,
              portfolio_row.label,
              portfolio_row.created_at
            FROM public.user_portfolios AS portfolio_row
            WHERE portfolio_row.user_id = p_user_id
            ORDER BY portfolio_row.id
            LIMIT 250001
          ) AS portfolio
        ),
        '[]'::jsonb
      ),
      'positions',
      COALESCE(
        (
          SELECT pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
              'id', position_row.id,
              'portfolio_id', position_row.portfolio_id,
              'symbol', position_row.symbol,
              'side', position_row.side,
              'entry_price', position_row.entry_price::text,
              'mark_price', position_row.mark_price::text,
              'size', position_row.size::text,
              'pnl', position_row.pnl::text,
              'pnl_pct', position_row.pnl_pct::text,
              'leverage', position_row.leverage::text,
              'updated_at', position_row.updated_at
            )
            ORDER BY position_row.id
          )
          FROM (
            SELECT
              raw_position.id,
              raw_position.portfolio_id,
              raw_position.symbol,
              raw_position.side,
              raw_position.entry_price,
              raw_position.mark_price,
              raw_position.size,
              raw_position.pnl,
              raw_position.pnl_pct,
              raw_position.leverage,
              raw_position.updated_at
            FROM public.user_positions AS raw_position
            JOIN public.user_portfolios AS portfolio_row
              ON portfolio_row.id = raw_position.portfolio_id
            WHERE portfolio_row.user_id = p_user_id
            ORDER BY raw_position.id
            LIMIT 250001
          ) AS position_row
        ),
        '[]'::jsonb
      ),
      'snapshots',
      COALESCE(
        (
          SELECT pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
              'id', snapshot_row.id,
              'portfolio_id', snapshot_row.portfolio_id,
              'total_equity', snapshot_row.total_equity::text,
              'total_pnl', snapshot_row.total_pnl::text,
              'total_pnl_pct', snapshot_row.total_pnl_pct::text,
              'snapshot_at', snapshot_row.snapshot_at
            )
            ORDER BY snapshot_row.id
          )
          FROM (
            SELECT
              raw_snapshot.id,
              raw_snapshot.portfolio_id,
              raw_snapshot.total_equity,
              raw_snapshot.total_pnl,
              raw_snapshot.total_pnl_pct,
              raw_snapshot.snapshot_at
            FROM public.user_portfolio_snapshots AS raw_snapshot
            JOIN public.user_portfolios AS portfolio_row
              ON portfolio_row.id = raw_snapshot.portfolio_id
            WHERE portfolio_row.user_id = p_user_id
            ORDER BY raw_snapshot.id
            LIMIT 250001
          ) AS snapshot_row
        ),
        '[]'::jsonb
      )
    )
  );
END
$function$;

ALTER FUNCTION public.export_legacy_portfolio_data_v1(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.export_legacy_portfolio_data_v1(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.export_legacy_portfolio_data_v1(uuid)
  TO service_role;

-- CREATE OR REPLACE preserves a pre-existing function's ACL. Converge any
-- dashboard/manual grants from the live catalog rather than assuming the
-- known Supabase roles are the only historical grantees.
DO $revoke_unexpected_legacy_portfolio_function_acl$
DECLARE
  v_acl record;
BEGIN
  FOR v_acl IN
    SELECT DISTINCT
      procedure.proname AS function_name,
      pg_catalog.pg_get_function_identity_arguments(procedure.oid) AS identity_arguments,
      grantee_role.rolname AS grantee_name
    FROM pg_catalog.pg_proc AS procedure
    CROSS JOIN LATERAL pg_catalog.aclexplode(procedure.proacl) AS acl_entry
    JOIN pg_catalog.pg_roles AS grantee_role
      ON grantee_role.oid = acl_entry.grantee
    WHERE procedure.oid IN (
      'public.delete_legacy_portfolio_v1(uuid,uuid)'::regprocedure,
      'public.export_legacy_portfolio_data_v1(uuid)'::regprocedure
    )
      AND acl_entry.privilege_type = 'EXECUTE'
      AND acl_entry.grantee <> procedure.proowner
      AND grantee_role.rolname <> 'service_role'
    ORDER BY procedure.proname, grantee_role.rolname
  LOOP
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON FUNCTION public.%I(%s) FROM %I',
      v_acl.function_name,
      v_acl.identity_arguments,
      v_acl.grantee_name
    );
  END LOOP;
END
$revoke_unexpected_legacy_portfolio_function_acl$;

-- Direct inventory access is metadata-only. In particular, service_role
-- cannot SELECT any ciphertext column or directly read child tables; portable
-- owner export is available only through the exact function above.
GRANT SELECT (id, user_id, exchange, label, created_at)
  ON TABLE public.user_portfolios
  TO service_role;

CREATE POLICY "Service reads legacy portfolio inventory"
  ON public.user_portfolios
  FOR SELECT TO service_role
  USING (true);

DO $postflight$
DECLARE
  v_table_name text;
  v_role name;
  v_privilege text;
  v_column name;
  v_allowed_metadata name[] := ARRAY[
    'id', 'user_id', 'exchange', 'label', 'created_at'
  ]::name[];
BEGIN
  FOREACH v_table_name IN ARRAY ARRAY[
    'user_portfolios',
    'user_positions',
    'user_portfolio_snapshots'
  ]::text[]
  LOOP
    IF NOT (
      SELECT relation.relrowsecurity
      FROM pg_catalog.pg_class AS relation
      WHERE relation.oid = pg_catalog.to_regclass('public.' || v_table_name)
    ) THEN
      RAISE EXCEPTION 'RLS is not enabled on public.%', v_table_name;
    END IF;

    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated']::name[]
    LOOP
      FOREACH v_privilege IN ARRAY ARRAY[
        'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'
      ]::text[]
      LOOP
        IF pg_catalog.has_table_privilege(
          v_role,
          pg_catalog.to_regclass('public.' || v_table_name),
          v_privilege
        ) THEN
          RAISE EXCEPTION '% still has % on public.%', v_role, v_privilege, v_table_name;
        END IF;
      END LOOP;
    END LOOP;

    FOREACH v_privilege IN ARRAY ARRAY[
      'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'
    ]::text[]
    LOOP
      IF pg_catalog.has_table_privilege(
        'service_role',
        pg_catalog.to_regclass('public.' || v_table_name),
        v_privilege
      ) THEN
        RAISE EXCEPTION
          'service_role still has retired % capability on public.%',
          v_privilege,
          v_table_name;
      END IF;
    END LOOP;

    FOR v_column IN
      SELECT attribute.attname
      FROM pg_catalog.pg_attribute AS attribute
      WHERE attribute.attrelid = pg_catalog.to_regclass('public.' || v_table_name)
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
    LOOP
      FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated']::name[]
      LOOP
        FOREACH v_privilege IN ARRAY ARRAY[
          'SELECT', 'INSERT', 'UPDATE', 'REFERENCES'
        ]::text[]
        LOOP
          IF pg_catalog.has_column_privilege(
            v_role,
            pg_catalog.to_regclass('public.' || v_table_name),
            v_column,
            v_privilege
          ) THEN
            RAISE EXCEPTION
              '% still has column % on public.%.%',
              v_role,
              v_privilege,
              v_table_name,
              v_column;
          END IF;
        END LOOP;
      END LOOP;

      FOREACH v_privilege IN ARRAY ARRAY[
        'INSERT', 'UPDATE', 'REFERENCES'
      ]::text[]
      LOOP
        IF pg_catalog.has_column_privilege(
          'service_role',
          pg_catalog.to_regclass('public.' || v_table_name),
          v_column,
          v_privilege
        ) THEN
          RAISE EXCEPTION
            'service_role still has column % on public.%.%',
            v_privilege,
            v_table_name,
            v_column;
        END IF;
      END LOOP;

      IF (
        v_table_name <> 'user_portfolios'
        OR NOT (v_column = ANY(v_allowed_metadata))
      ) AND pg_catalog.has_column_privilege(
        'service_role',
        pg_catalog.to_regclass('public.' || v_table_name),
        v_column,
        'SELECT'
      ) THEN
        RAISE EXCEPTION
          'service_role has out-of-scope SELECT on public.%.%',
          v_table_name,
          v_column;
      END IF;
    END LOOP;
  END LOOP;

  FOREACH v_column IN ARRAY v_allowed_metadata
  LOOP
    IF NOT pg_catalog.has_column_privilege(
      'service_role',
      'public.user_portfolios',
      v_column,
      'SELECT'
    ) THEN
      RAISE EXCEPTION 'service_role metadata SELECT is missing for %', v_column;
    END IF;
  END LOOP;

  IF NOT pg_catalog.has_function_privilege(
    'service_role',
    'public.delete_legacy_portfolio_v1(uuid,uuid)',
    'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'anon',
    'public.delete_legacy_portfolio_v1(uuid,uuid)',
    'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'authenticated',
    'public.delete_legacy_portfolio_v1(uuid,uuid)',
    'EXECUTE'
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.aclexplode(
      (
        SELECT procedure.proacl
        FROM pg_catalog.pg_proc AS procedure
        WHERE procedure.oid = 'public.delete_legacy_portfolio_v1(uuid,uuid)'::regprocedure
      )
    ) AS acl_entry
    WHERE acl_entry.grantee = 0::oid
      AND acl_entry.privilege_type = 'EXECUTE'
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS procedure
    CROSS JOIN LATERAL pg_catalog.aclexplode(procedure.proacl) AS acl_entry
    WHERE procedure.oid = 'public.delete_legacy_portfolio_v1(uuid,uuid)'::regprocedure
      AND acl_entry.privilege_type = 'EXECUTE'
      AND acl_entry.grantee <> procedure.proowner
      AND acl_entry.grantee <> (
        SELECT role_row.oid
        FROM pg_catalog.pg_roles AS role_row
        WHERE role_row.rolname = 'service_role'
      )
  ) OR (
    SELECT owner_role.rolname
    FROM pg_catalog.pg_proc AS procedure
    JOIN pg_catalog.pg_roles AS owner_role
      ON owner_role.oid = procedure.proowner
    WHERE procedure.oid = 'public.delete_legacy_portfolio_v1(uuid,uuid)'::regprocedure
  ) IS DISTINCT FROM 'postgres' THEN
    RAISE EXCEPTION 'legacy portfolio removal capability ACL drift remains';
  END IF;

  IF NOT pg_catalog.has_function_privilege(
    'service_role',
    'public.export_legacy_portfolio_data_v1(uuid)',
    'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'anon',
    'public.export_legacy_portfolio_data_v1(uuid)',
    'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'authenticated',
    'public.export_legacy_portfolio_data_v1(uuid)',
    'EXECUTE'
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.aclexplode(
      (
        SELECT procedure.proacl
        FROM pg_catalog.pg_proc AS procedure
        WHERE procedure.oid = 'public.export_legacy_portfolio_data_v1(uuid)'::regprocedure
      )
    ) AS acl_entry
    WHERE acl_entry.grantee = 0::oid
      AND acl_entry.privilege_type = 'EXECUTE'
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS procedure
    CROSS JOIN LATERAL pg_catalog.aclexplode(procedure.proacl) AS acl_entry
    WHERE procedure.oid = 'public.export_legacy_portfolio_data_v1(uuid)'::regprocedure
      AND acl_entry.privilege_type = 'EXECUTE'
      AND acl_entry.grantee <> procedure.proowner
      AND acl_entry.grantee <> (
        SELECT role_row.oid
        FROM pg_catalog.pg_roles AS role_row
        WHERE role_row.rolname = 'service_role'
      )
  ) OR (
    SELECT owner_role.rolname
    FROM pg_catalog.pg_proc AS procedure
    JOIN pg_catalog.pg_roles AS owner_role
      ON owner_role.oid = procedure.proowner
    WHERE procedure.oid = 'public.export_legacy_portfolio_data_v1(uuid)'::regprocedure
  ) IS DISTINCT FROM 'postgres' THEN
    RAISE EXCEPTION 'legacy portfolio export capability ACL or owner drift remains';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid IN (
      'public.user_portfolios'::regclass,
      'public.user_positions'::regclass,
      'public.user_portfolio_snapshots'::regclass
    )
  ) <> 1 OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.user_portfolios'::regclass
      AND policy.polname = 'Service reads legacy portfolio inventory'
      AND policy.polcmd = 'r'
      AND policy.polpermissive
      AND policy.polroles = ARRAY[
        (SELECT role_row.oid FROM pg_catalog.pg_roles AS role_row WHERE role_row.rolname = 'service_role')
      ]::oid[]
      AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid) = 'true'
      AND policy.polwithcheck IS NULL
  ) THEN
    RAISE EXCEPTION 'legacy portfolio policies did not converge to one service metadata policy';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid IN (
      'public.user_portfolios'::regclass,
      'public.user_positions'::regclass,
      'public.user_portfolio_snapshots'::regclass
    )
      AND policy.polroles <> ARRAY[
        (SELECT role_row.oid FROM pg_catalog.pg_roles AS role_row WHERE role_row.rolname = 'service_role')
      ]::oid[]
  ) THEN
    RAISE EXCEPTION 'legacy portfolio policy role drift remains';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
