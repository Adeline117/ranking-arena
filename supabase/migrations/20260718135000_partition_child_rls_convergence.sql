-- Partition children are implementation details: callers read and write through
-- the partitioned parent, whose grants and RLS policies are the authority.
--
-- A legacy migration granted direct public access to every child, including
-- copier_records (service-only PII). The history range guard hardened only newly
-- created children and skipped existing attached children. Converge every child
-- now, and make the monthly helper converge both its existing and new paths.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

DO $preflight$
DECLARE
  v_parent_table text;
  v_parent_oid oid;
BEGIN
  FOREACH v_parent_table IN ARRAY ARRAY[
    'leaderboard_entries',
    'trader_series',
    'position_history',
    'order_records',
    'transfer_history',
    'copier_records'
  ]::text[]
  LOOP
    v_parent_oid := pg_catalog.to_regclass('arena.' || v_parent_table);
    IF v_parent_oid IS NULL
      OR NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_class AS relation
        WHERE relation.oid = v_parent_oid
          AND relation.relkind = 'p'
      )
    THEN
      RAISE EXCEPTION 'arena partition parent is missing or invalid: %', v_parent_table;
    END IF;
  END LOOP;

  IF pg_catalog.to_regprocedure(
    'arena.ensure_month_partitions(text,integer,integer)'
  ) IS NULL THEN
    RAISE EXCEPTION 'arena.ensure_month_partitions prerequisite is missing';
  END IF;
END
$preflight$;

-- Keep ordinary reads/writes flowing, but serialize CREATE/ATTACH/DETACH
-- partition DDL until the function replacement, convergence, and postflight
-- checks commit as one boundary.
LOCK TABLE ONLY arena.copier_records IN SHARE UPDATE EXCLUSIVE MODE;
LOCK TABLE ONLY arena.leaderboard_entries IN SHARE UPDATE EXCLUSIVE MODE;
LOCK TABLE ONLY arena.order_records IN SHARE UPDATE EXCLUSIVE MODE;
LOCK TABLE ONLY arena.position_history IN SHARE UPDATE EXCLUSIVE MODE;
LOCK TABLE ONLY arena.trader_series IN SHARE UPDATE EXCLUSIVE MODE;
LOCK TABLE ONLY arena.transfer_history IN SHARE UPDATE EXCLUSIVE MODE;

DO $child_namespace_preflight$
DECLARE
  v_cross_schema_children text;
BEGIN
  WITH RECURSIVE roots(root_oid) AS (
    SELECT parent.oid
    FROM pg_catalog.pg_class AS parent
    JOIN pg_catalog.pg_namespace AS parent_schema
      ON parent_schema.oid = parent.relnamespace
    WHERE parent_schema.nspname = 'arena'
      AND parent.relname IN (
        'leaderboard_entries',
        'trader_series',
        'position_history',
        'order_records',
        'transfer_history',
        'copier_records'
      )
  ),
  descendants(root_oid, relid) AS (
    SELECT roots.root_oid, inheritance.inhrelid
    FROM roots
    JOIN pg_catalog.pg_inherits AS inheritance
      ON inheritance.inhparent = roots.root_oid
    UNION ALL
    SELECT descendants.root_oid, inheritance.inhrelid
    FROM descendants
    JOIN pg_catalog.pg_inherits AS inheritance
      ON inheritance.inhparent = descendants.relid
  )
  SELECT pg_catalog.string_agg(
    pg_catalog.format('%I.%I', child_schema.nspname, child.relname),
    ', '
    ORDER BY child_schema.nspname, child.relname
  )
  INTO v_cross_schema_children
  FROM descendants
  JOIN pg_catalog.pg_class AS child
    ON child.oid = descendants.relid
  JOIN pg_catalog.pg_namespace AS child_schema
    ON child_schema.oid = child.relnamespace
  WHERE child_schema.nspname <> 'arena';

  IF v_cross_schema_children IS NOT NULL THEN
    RAISE EXCEPTION
      'arena partition parents retained cross-schema children: %',
      v_cross_schema_children;
  END IF;
END
$child_namespace_preflight$;

CREATE OR REPLACE FUNCTION arena.ensure_month_partitions(
  parent_table text,
  months_ahead integer DEFAULT 2,
  months_back integer DEFAULT 0
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_parent_oid oid;
  v_month date;
  v_partition_name text;
  v_partition_oid oid;
  v_created integer := 0;
  v_offset integer;
  v_acl record;
  v_policy_name text;
BEGIN
  IF parent_table NOT IN (
    'leaderboard_entries',
    'trader_series',
    'position_history',
    'order_records',
    'transfer_history',
    'copier_records'
  ) THEN
    RAISE EXCEPTION 'ensure_month_partitions: unsupported table %', parent_table
      USING ERRCODE = '22023';
  END IF;
  IF months_ahead IS NULL
    OR months_back IS NULL
    OR months_ahead < 0
    OR months_ahead > 24
    OR months_back < 0
    OR months_back > 120
  THEN
    RAISE EXCEPTION
      'ensure_month_partitions: range is outside 0..24 ahead / 0..120 back'
      USING ERRCODE = '22023';
  END IF;

  v_parent_oid := pg_catalog.to_regclass('arena.' || parent_table);
  IF v_parent_oid IS NULL
    OR NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS relation
      WHERE relation.oid = v_parent_oid
        AND relation.relkind = 'p'
    )
  THEN
    RAISE EXCEPTION 'ensure_month_partitions: invalid partition parent %', parent_table
      USING ERRCODE = '42P01';
  END IF;

  FOR v_offset IN -months_back..months_ahead LOOP
    v_month := (
      pg_catalog.date_trunc('month', pg_catalog.statement_timestamp())
      + (v_offset::text || ' months')::interval
    )::date;
    v_partition_name := pg_catalog.format(
      '%s_y%sm%s',
      parent_table,
      pg_catalog.to_char(v_month, 'YYYY'),
      pg_catalog.to_char(v_month, 'MM')
    );

    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'arena-month-partition:' || parent_table || ':' || v_month::text,
        0
      )
    );

    v_partition_oid := pg_catalog.to_regclass('arena.' || v_partition_name);
    IF v_partition_oid IS NOT NULL THEN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_inherits AS inheritance
        WHERE inheritance.inhparent = v_parent_oid
          AND inheritance.inhrelid = v_partition_oid
      ) THEN
        RAISE EXCEPTION
          'ensure_month_partitions: relation arena.% exists but is not attached to arena.%',
          v_partition_name,
          parent_table;
      END IF;
    ELSE
      EXECUTE pg_catalog.format(
        'CREATE TABLE arena.%I PARTITION OF arena.%I FOR VALUES FROM (%L) TO (%L)',
        v_partition_name,
        parent_table,
        v_month,
        (v_month + interval '1 month')::date
      );
      v_partition_oid := pg_catalog.to_regclass('arena.' || v_partition_name);
      v_created := v_created + 1;
    END IF;

    EXECUTE pg_catalog.format(
      'ALTER TABLE arena.%I ENABLE ROW LEVEL SECURITY',
      v_partition_name
    );

    FOR v_acl IN
      SELECT DISTINCT
        privilege.grantee,
        grantee_role.rolname
      FROM pg_catalog.pg_class AS child
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          child.relacl,
          pg_catalog.acldefault('r', child.relowner)
        )
      ) AS privilege
      LEFT JOIN pg_catalog.pg_roles AS grantee_role
        ON grantee_role.oid = privilege.grantee
      WHERE child.oid = v_partition_oid
        AND privilege.grantee <> child.relowner
    LOOP
      IF v_acl.grantee = 0 THEN
        EXECUTE pg_catalog.format(
          'REVOKE ALL ON TABLE arena.%I FROM PUBLIC',
          v_partition_name
        );
      ELSIF v_acl.rolname IS NULL THEN
        RAISE EXCEPTION
          'ensure_month_partitions: unresolved grantee % on arena.%',
          v_acl.grantee,
          v_partition_name;
      ELSE
        EXECUTE pg_catalog.format(
          'REVOKE ALL ON TABLE arena.%I FROM %I',
          v_partition_name,
          v_acl.rolname
        );
      END IF;
    END LOOP;

    FOR v_policy_name IN
      SELECT policy.polname
      FROM pg_catalog.pg_policy AS policy
      WHERE policy.polrelid = v_partition_oid
    LOOP
      EXECUTE pg_catalog.format(
        'DROP POLICY %I ON arena.%I',
        v_policy_name,
        v_partition_name
      );
    END LOOP;
  END LOOP;

  RETURN v_created;
END
$function$;

ALTER FUNCTION arena.ensure_month_partitions(text, integer, integer)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION arena.ensure_month_partitions(text, integer, integer)
  FROM PUBLIC, anon, authenticated, service_role;

DO $converge_children$
DECLARE
  v_child record;
  v_acl record;
  v_policy_name text;
BEGIN
  FOR v_child IN
    WITH RECURSIVE roots(root_oid, root_name) AS (
      SELECT parent.oid, parent.relname
      FROM pg_catalog.pg_class AS parent
      JOIN pg_catalog.pg_namespace AS parent_schema
        ON parent_schema.oid = parent.relnamespace
      WHERE parent_schema.nspname = 'arena'
        AND parent.relname IN (
          'leaderboard_entries',
          'trader_series',
          'position_history',
          'order_records',
          'transfer_history',
          'copier_records'
        )
    ),
    descendants(root_oid, root_name, relid) AS (
      SELECT roots.root_oid, roots.root_name, inheritance.inhrelid
      FROM roots
      JOIN pg_catalog.pg_inherits AS inheritance
        ON inheritance.inhparent = roots.root_oid
      UNION ALL
      SELECT descendants.root_oid, descendants.root_name, inheritance.inhrelid
      FROM descendants
      JOIN pg_catalog.pg_inherits AS inheritance
        ON inheritance.inhparent = descendants.relid
    )
    SELECT
      child.oid,
      child.relname,
      child.relowner,
      descendants.root_name AS parent_name
    FROM descendants
    JOIN pg_catalog.pg_class AS child
      ON child.oid = descendants.relid
    JOIN pg_catalog.pg_namespace AS child_schema
      ON child_schema.oid = child.relnamespace
    WHERE child_schema.nspname = 'arena'
      AND child.relispartition
    ORDER BY descendants.root_name, child.relname
  LOOP
    EXECUTE pg_catalog.format(
      'ALTER TABLE arena.%I ENABLE ROW LEVEL SECURITY',
      v_child.relname
    );

    FOR v_acl IN
      SELECT DISTINCT
        privilege.grantee,
        grantee_role.rolname
      FROM pg_catalog.pg_class AS child
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          child.relacl,
          pg_catalog.acldefault('r', child.relowner)
        )
      ) AS privilege
      LEFT JOIN pg_catalog.pg_roles AS grantee_role
        ON grantee_role.oid = privilege.grantee
      WHERE child.oid = v_child.oid
        AND privilege.grantee <> child.relowner
    LOOP
      IF v_acl.grantee = 0 THEN
        EXECUTE pg_catalog.format(
          'REVOKE ALL ON TABLE arena.%I FROM PUBLIC',
          v_child.relname
        );
      ELSIF v_acl.rolname IS NULL THEN
        RAISE EXCEPTION
          'partition convergence: unresolved grantee % on arena.%',
          v_acl.grantee,
          v_child.relname;
      ELSE
        EXECUTE pg_catalog.format(
          'REVOKE ALL ON TABLE arena.%I FROM %I',
          v_child.relname,
          v_acl.rolname
        );
      END IF;
    END LOOP;

    FOR v_policy_name IN
      SELECT policy.polname
      FROM pg_catalog.pg_policy AS policy
      WHERE policy.polrelid = v_child.oid
    LOOP
      EXECUTE pg_catalog.format(
        'DROP POLICY %I ON arena.%I',
        v_policy_name,
        v_child.relname
      );
    END LOOP;
  END LOOP;
END
$converge_children$;

DO $postflight$
DECLARE
  v_relation text;
BEGIN
  WITH RECURSIVE roots(root_oid, root_name) AS (
    SELECT parent.oid, parent.relname
    FROM pg_catalog.pg_class AS parent
    JOIN pg_catalog.pg_namespace AS parent_schema
      ON parent_schema.oid = parent.relnamespace
    WHERE parent_schema.nspname = 'arena'
      AND parent.relname IN (
        'leaderboard_entries',
        'trader_series',
        'position_history',
        'order_records',
        'transfer_history',
        'copier_records'
      )
  ),
  descendants(root_oid, root_name, relid) AS (
    SELECT roots.root_oid, roots.root_name, inheritance.inhrelid
    FROM roots
    JOIN pg_catalog.pg_inherits AS inheritance
      ON inheritance.inhparent = roots.root_oid
    UNION ALL
    SELECT descendants.root_oid, descendants.root_name, inheritance.inhrelid
    FROM descendants
    JOIN pg_catalog.pg_inherits AS inheritance
      ON inheritance.inhparent = descendants.relid
  )
  SELECT pg_catalog.string_agg(
    pg_catalog.format('arena.%I', child.relname),
    ', '
    ORDER BY descendants.root_name, child.relname
  )
  INTO v_relation
  FROM descendants
  JOIN pg_catalog.pg_class AS child
    ON child.oid = descendants.relid
  JOIN pg_catalog.pg_namespace AS child_schema
    ON child_schema.oid = child.relnamespace
  WHERE child_schema.nspname = 'arena'
    AND child.relispartition
    AND NOT child.relrowsecurity;

  IF v_relation IS NOT NULL THEN
    RAISE EXCEPTION 'partition children retained RLS-disabled relations: %', v_relation;
  END IF;

  WITH RECURSIVE roots(root_oid) AS (
    SELECT parent.oid
    FROM pg_catalog.pg_class AS parent
    JOIN pg_catalog.pg_namespace AS parent_schema
      ON parent_schema.oid = parent.relnamespace
    WHERE parent_schema.nspname = 'arena'
      AND parent.relname IN (
        'leaderboard_entries',
        'trader_series',
        'position_history',
        'order_records',
        'transfer_history',
        'copier_records'
      )
  ),
  descendants(root_oid, relid) AS (
    SELECT roots.root_oid, inheritance.inhrelid
    FROM roots
    JOIN pg_catalog.pg_inherits AS inheritance
      ON inheritance.inhparent = roots.root_oid
    UNION ALL
    SELECT descendants.root_oid, inheritance.inhrelid
    FROM descendants
    JOIN pg_catalog.pg_inherits AS inheritance
      ON inheritance.inhparent = descendants.relid
  )
  SELECT pg_catalog.string_agg(
    pg_catalog.format('arena.%I', child.relname),
    ', '
    ORDER BY child.relname
  )
  INTO v_relation
  FROM descendants
  JOIN pg_catalog.pg_class AS child
    ON child.oid = descendants.relid
  JOIN pg_catalog.pg_namespace AS child_schema
    ON child_schema.oid = child.relnamespace
  WHERE child_schema.nspname = 'arena'
    AND child.relispartition
    AND child.relowner <> 'postgres'::pg_catalog.regrole::oid;

  IF v_relation IS NOT NULL THEN
    RAISE EXCEPTION 'partition children retained non-postgres owners: %', v_relation;
  END IF;

  WITH RECURSIVE roots(root_oid) AS (
    SELECT parent.oid
    FROM pg_catalog.pg_class AS parent
    JOIN pg_catalog.pg_namespace AS parent_schema
      ON parent_schema.oid = parent.relnamespace
    WHERE parent_schema.nspname = 'arena'
      AND parent.relname IN (
        'leaderboard_entries',
        'trader_series',
        'position_history',
        'order_records',
        'transfer_history',
        'copier_records'
      )
  ),
  descendants(root_oid, relid) AS (
    SELECT roots.root_oid, inheritance.inhrelid
    FROM roots
    JOIN pg_catalog.pg_inherits AS inheritance
      ON inheritance.inhparent = roots.root_oid
    UNION ALL
    SELECT descendants.root_oid, inheritance.inhrelid
    FROM descendants
    JOIN pg_catalog.pg_inherits AS inheritance
      ON inheritance.inhparent = descendants.relid
  )
  SELECT pg_catalog.string_agg(
    DISTINCT pg_catalog.format('arena.%I', child.relname),
    ', '
    ORDER BY pg_catalog.format('arena.%I', child.relname)
  )
  INTO v_relation
  FROM descendants
  JOIN pg_catalog.pg_class AS child
    ON child.oid = descendants.relid
  JOIN pg_catalog.pg_namespace AS child_schema
    ON child_schema.oid = child.relnamespace
  CROSS JOIN LATERAL pg_catalog.aclexplode(
    COALESCE(
      child.relacl,
      pg_catalog.acldefault('r', child.relowner)
    )
  ) AS privilege
  WHERE child_schema.nspname = 'arena'
    AND child.relispartition
    AND privilege.grantee <> child.relowner;

  IF v_relation IS NOT NULL THEN
    RAISE EXCEPTION 'partition children retained non-owner ACLs: %', v_relation;
  END IF;

  WITH RECURSIVE roots(root_oid) AS (
    SELECT parent.oid
    FROM pg_catalog.pg_class AS parent
    JOIN pg_catalog.pg_namespace AS parent_schema
      ON parent_schema.oid = parent.relnamespace
    WHERE parent_schema.nspname = 'arena'
      AND parent.relname IN (
        'leaderboard_entries',
        'trader_series',
        'position_history',
        'order_records',
        'transfer_history',
        'copier_records'
      )
  ),
  descendants(root_oid, relid) AS (
    SELECT roots.root_oid, inheritance.inhrelid
    FROM roots
    JOIN pg_catalog.pg_inherits AS inheritance
      ON inheritance.inhparent = roots.root_oid
    UNION ALL
    SELECT descendants.root_oid, inheritance.inhrelid
    FROM descendants
    JOIN pg_catalog.pg_inherits AS inheritance
      ON inheritance.inhparent = descendants.relid
  )
  SELECT pg_catalog.string_agg(
    pg_catalog.format('arena.%I:%I', child.relname, policy.polname),
    ', '
    ORDER BY child.relname, policy.polname
  )
  INTO v_relation
  FROM descendants
  JOIN pg_catalog.pg_class AS child
    ON child.oid = descendants.relid
  JOIN pg_catalog.pg_policy AS policy
    ON policy.polrelid = child.oid
  JOIN pg_catalog.pg_namespace AS child_schema
    ON child_schema.oid = child.relnamespace
  WHERE child_schema.nspname = 'arena';

  IF v_relation IS NOT NULL THEN
    RAISE EXCEPTION 'partition children retained direct policies: %', v_relation;
  END IF;
END
$postflight$;

COMMIT;
