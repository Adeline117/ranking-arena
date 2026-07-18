-- History adapters can legitimately return records older than the rolling
-- seven-month partition window. Ranked traders retain their full history, so
-- dropping those rows or creating a DEFAULT partition would violate the
-- serving contract. Create the exact required range before publishing a batch,
-- while bounding source timestamps and keeping partition DDL owner-only.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

DO $preflight$
DECLARE
  v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'leaderboard_entries',
    'trader_series',
    'position_history',
    'order_records',
    'transfer_history',
    'copier_records'
  ]::text[]
  LOOP
    IF pg_catalog.to_regclass('arena.' || v_table) IS NULL THEN
      RAISE EXCEPTION 'arena partition parent is missing: %', v_table;
    END IF;
  END LOOP;

  IF pg_catalog.to_regprocedure(
    'arena.ensure_month_partitions(text,integer,integer)'
  ) IS NULL THEN
    RAISE EXCEPTION 'arena.ensure_month_partitions prerequisite is missing';
  END IF;
END
$preflight$;

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
      CONTINUE;
    END IF;

    EXECUTE pg_catalog.format(
      'CREATE TABLE arena.%I PARTITION OF arena.%I FOR VALUES FROM (%L) TO (%L)',
      v_partition_name,
      parent_table,
      v_month,
      (v_month + interval '1 month')::date
    );
    EXECUTE pg_catalog.format(
      'ALTER TABLE arena.%I ENABLE ROW LEVEL SECURITY',
      v_partition_name
    );
    EXECUTE pg_catalog.format(
      'REVOKE ALL ON TABLE arena.%I FROM PUBLIC, anon, authenticated, service_role',
      v_partition_name
    );
    v_created := v_created + 1;
  END LOOP;

  RETURN v_created;
END
$function$;

ALTER FUNCTION arena.ensure_month_partitions(text, integer, integer)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION arena.ensure_month_partitions(text, integer, integer)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION arena.ensure_history_partitions(
  parent_table text,
  source_timestamps timestamptz[]
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_now_month date :=
    pg_catalog.date_trunc('month', pg_catalog.statement_timestamp())::date;
  v_min_month date;
  v_max_month date;
  v_months_back integer;
  v_months_ahead integer;
BEGIN
  IF parent_table NOT IN (
    'order_records',
    'transfer_history',
    'copier_records'
  ) THEN
    RAISE EXCEPTION 'ensure_history_partitions: unsupported table %', parent_table
      USING ERRCODE = '22023';
  END IF;
  IF source_timestamps IS NULL
    OR pg_catalog.cardinality(source_timestamps) = 0
    OR pg_catalog.cardinality(source_timestamps) > 5000
    OR pg_catalog.array_position(source_timestamps, NULL::timestamptz) IS NOT NULL
  THEN
    RAISE EXCEPTION 'ensure_history_partitions: invalid timestamp batch'
      USING ERRCODE = '22023';
  END IF;

  SELECT
    pg_catalog.min(
      pg_catalog.date_trunc('month', source_timestamp)
    )::date,
    pg_catalog.max(
      pg_catalog.date_trunc('month', source_timestamp)
    )::date
  INTO v_min_month, v_max_month
  FROM pg_catalog.unnest(source_timestamps) AS source_timestamp;

  IF v_min_month < (v_now_month - interval '10 years')::date
    OR v_max_month > (v_now_month + interval '2 months')::date
  THEN
    RAISE EXCEPTION
      'ensure_history_partitions: source timestamp range %..% is implausible',
      v_min_month,
      v_max_month
      USING ERRCODE = '22023';
  END IF;

  v_months_back := GREATEST(
    0,
    (
      (EXTRACT(year FROM v_now_month)::integer
        - EXTRACT(year FROM v_min_month)::integer) * 12
      + EXTRACT(month FROM v_now_month)::integer
      - EXTRACT(month FROM v_min_month)::integer
    )
  );
  v_months_ahead := GREATEST(
    2,
    (
      (EXTRACT(year FROM v_max_month)::integer
        - EXTRACT(year FROM v_now_month)::integer) * 12
      + EXTRACT(month FROM v_max_month)::integer
      - EXTRACT(month FROM v_now_month)::integer
    )
  );

  RETURN arena.ensure_month_partitions(
    parent_table,
    v_months_ahead,
    v_months_back
  );
END
$function$;

ALTER FUNCTION arena.ensure_history_partitions(text, timestamptz[])
  OWNER TO postgres;
REVOKE ALL ON FUNCTION arena.ensure_history_partitions(text, timestamptz[])
  FROM PUBLIC, anon, authenticated, service_role;

DO $converge_function_acl$
DECLARE
  v_function_oid oid;
  v_grantee_name text;
BEGIN
  FOREACH v_function_oid IN ARRAY ARRAY[
    'arena.ensure_month_partitions(text,integer,integer)'::pg_catalog.regprocedure::oid,
    'arena.ensure_history_partitions(text,timestamp with time zone[])'::pg_catalog.regprocedure::oid
  ]::oid[]
  LOOP
    FOR v_grantee_name IN
      SELECT DISTINCT grantee_role.rolname
      FROM pg_catalog.pg_proc AS function_row
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          function_row.proacl,
          pg_catalog.acldefault('f', function_row.proowner)
        )
      ) AS privilege
      JOIN pg_catalog.pg_roles AS grantee_role
        ON grantee_role.oid = privilege.grantee
      WHERE function_row.oid = v_function_oid
        AND privilege.grantee <> function_row.proowner
    LOOP
      EXECUTE pg_catalog.format(
        'REVOKE ALL ON FUNCTION %s FROM %I',
        v_function_oid::pg_catalog.regprocedure,
        v_grantee_name
      );
    END LOOP;
  END LOOP;
END
$converge_function_acl$;

-- The live failure involved September/October 2025 records returned by a
-- currently ranked BitMart trader. Seed a modest twelve-month runway so the
-- already-deployed worker can retry successfully before the code-side
-- per-batch guard is promoted.
SELECT arena.ensure_month_partitions('order_records', 2, 12);
SELECT arena.ensure_month_partitions('transfer_history', 2, 12);
SELECT arena.ensure_month_partitions('copier_records', 2, 12);

DO $postflight$
DECLARE
  v_function_oid oid;
BEGIN
  FOREACH v_function_oid IN ARRAY ARRAY[
    'arena.ensure_month_partitions(text,integer,integer)'::pg_catalog.regprocedure::oid,
    'arena.ensure_history_partitions(text,timestamp with time zone[])'::pg_catalog.regprocedure::oid
  ]::oid[]
  LOOP
    IF EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS function_row
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          function_row.proacl,
          pg_catalog.acldefault('f', function_row.proowner)
        )
      ) AS privilege
      WHERE function_row.oid = v_function_oid
        AND privilege.privilege_type = 'EXECUTE'
        AND privilege.grantee <> function_row.proowner
    ) THEN
      RAISE EXCEPTION 'partition function retained a non-owner EXECUTE grant';
    END IF;
  END LOOP;

  IF pg_catalog.has_function_privilege(
    'anon',
    'arena.ensure_history_partitions(text,timestamp with time zone[])',
    'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'authenticated',
    'arena.ensure_history_partitions(text,timestamp with time zone[])',
    'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'service_role',
    'arena.ensure_history_partitions(text,timestamp with time zone[])',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'history partition function is externally executable';
  END IF;
END
$postflight$;

COMMIT;
