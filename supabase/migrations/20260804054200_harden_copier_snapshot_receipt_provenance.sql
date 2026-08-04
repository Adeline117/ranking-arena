-- Fail-closed copier snapshot subject and clock admission.
--
-- The V1 publisher receives one `ts` value per copier row, but current Tier-C
-- adapters populate it with the acquisition clock rather than a proven
-- upstream copier event clock. Preserve that value only inside the immutable
-- request/RAW evidence and never project it as source-event provenance.
--
-- The 054000 publisher also takes only FOR KEY SHARE on the subject. A normal
-- claim metadata UPDATE is compatible with that row lock. The publication
-- INSERT trigger below upgrades the final admission point to FOR SHARE so a
-- claim and a new receipt cannot cross each other in flight.

BEGIN;

SET TRANSACTION ISOLATION LEVEL READ COMMITTED;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '2min';
SET LOCAL TIME ZONE 'UTC';
SET LOCAL search_path = pg_catalog, pg_temp;

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended(
    '20260804-harden-copier-snapshot-receipt-provenance',
    0
  )
);

DO $foundation_preflight$
DECLARE
  v_publisher oid := pg_catalog.to_regprocedure(
    'public.publish_copier_snapshot_v1(jsonb)'
  );
BEGIN
  IF pg_catalog.current_setting('server_version_num')::integer / 10000 <> 17
     OR current_user IS DISTINCT FROM 'postgres'
     OR pg_catalog.to_regrole('postgres') IS NULL
     OR pg_catalog.to_regrole('anon') IS NULL
     OR pg_catalog.to_regrole('authenticated') IS NULL
     OR pg_catalog.to_regrole('service_role') IS NULL
     OR pg_catalog.to_regclass('arena.sources') IS NULL
     OR pg_catalog.to_regclass('arena.traders') IS NULL
     OR pg_catalog.to_regclass(
       'arena.copier_snapshot_publications'
     ) IS NULL
     OR pg_catalog.to_regclass('arena.copier_snapshot_rows') IS NULL
     OR v_publisher IS NULL THEN
    RAISE EXCEPTION 'copier snapshot provenance hardening requires PG17 and the complete 054000 authority';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS procedure
    WHERE procedure.oid = v_publisher
      AND procedure.proowner = 'postgres'::pg_catalog.regrole
      AND procedure.prosecdef
      AND procedure.provolatile = 'v'
      AND procedure.proconfig IS NOT DISTINCT FROM
          ARRAY['search_path=pg_catalog, pg_temp']::text[]
      AND pg_catalog.strpos(
        procedure.prosrc,
        'arena-copier-source-run:'
      ) > 0
      AND pg_catalog.strpos(
        procedure.prosrc,
        'INSERT INTO arena.copier_snapshot_publications'
      ) > 0
      AND pg_catalog.strpos(
        procedure.prosrc,
        'INSERT INTO arena.copier_snapshot_rows'
      ) > 0
  ) OR NOT pg_catalog.has_function_privilege(
    'service_role',
    'public.publish_copier_snapshot_v1(jsonb)',
    'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'anon',
    'public.publish_copier_snapshot_v1(jsonb)',
    'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'authenticated',
    'public.publish_copier_snapshot_v1(jsonb)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'copier snapshot publisher lineage or ACL drifted before provenance hardening';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = 'arena.sources'::pg_catalog.regclass
      AND attribute.attname = 'status'
      AND attribute.atttypid = 'pg_catalog.text'::pg_catalog.regtype
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = 'arena.sources'::pg_catalog.regclass
      AND attribute.attname = 'serving_mode'
      AND attribute.atttypid = 'pg_catalog.text'::pg_catalog.regtype
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = 'arena.sources'::pg_catalog.regclass
      AND attribute.attname = 'copier_table_depth'
      AND attribute.atttypid = 'pg_catalog.text'::pg_catalog.regtype
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = 'arena.sources'::pg_catalog.regclass
      AND attribute.attname = 'currency'
      AND attribute.atttypid = 'pg_catalog.text'::pg_catalog.regtype
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = 'arena.traders'::pg_catalog.regclass
      AND attribute.attname = 'source_id'
      AND attribute.atttypid = 'pg_catalog.int2'::pg_catalog.regtype
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = 'arena.traders'::pg_catalog.regclass
      AND attribute.attname = 'meta'
      AND attribute.atttypid = 'pg_catalog.jsonb'::pg_catalog.regtype
      AND attribute.attnotnull
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid =
        'arena.copier_snapshot_rows'::pg_catalog.regclass
      AND attribute.attname = 'source_event_at'
      AND attribute.atttypid =
          'pg_catalog.timestamptz'::pg_catalog.regtype
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  ) THEN
    RAISE EXCEPTION 'copier snapshot subject or provenance column shape drifted';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_trigger AS trigger
    WHERE trigger.tgrelid IN (
      'arena.copier_snapshot_publications'::pg_catalog.regclass,
      'arena.copier_snapshot_rows'::pg_catalog.regclass
    )
      AND NOT trigger.tgisinternal
      AND trigger.tgenabled = 'O'
      AND trigger.tgname IN (
        'copier_snapshot_publication_reject_update_delete',
        'copier_snapshot_publication_reject_truncate',
        'copier_snapshot_row_reject_update_delete',
        'copier_snapshot_row_reject_truncate'
      )
  ) <> 4 THEN
    RAISE EXCEPTION 'copier snapshot immutable trigger lineage drifted';
  END IF;
END
$foundation_preflight$;

-- READ COMMITTED is deliberate: the catalog preflight above must not freeze a
-- transaction snapshot that could hide a receipt committed while these locks
-- are draining writers. After the locks are held, the empty-table preflight
-- below observes the latest committed state.
LOCK TABLE ONLY arena.sources IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE ONLY arena.traders IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE ONLY arena.copier_snapshot_publications IN ACCESS EXCLUSIVE MODE;
LOCK TABLE ONLY arena.copier_snapshot_rows IN ACCESS EXCLUSIVE MODE;

DO $locked_preflight$
DECLARE
  v_guard oid := pg_catalog.to_regprocedure(
    'arena.guard_copier_snapshot_publication_insert_v1()'
  );
  v_normalizer oid := pg_catalog.to_regprocedure(
    'arena.normalize_copier_snapshot_row_source_event_v1()'
  );
  v_source_event_not_null boolean;
  v_existing_hardening boolean;
  v_source_event_comment text;
BEGIN
  IF EXISTS (
    SELECT 1 FROM arena.copier_snapshot_publications LIMIT 1
  ) OR EXISTS (
    SELECT 1 FROM arena.copier_snapshot_rows LIMIT 1
  ) THEN
    RAISE EXCEPTION 'copier snapshot provenance hardening requires zero existing receipts and rows';
  END IF;

  SELECT attribute.attnotnull
  INTO STRICT v_source_event_not_null
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid =
      'arena.copier_snapshot_rows'::pg_catalog.regclass
    AND attribute.attname = 'source_event_at'
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;

  v_source_event_comment := pg_catalog.col_description(
    'arena.copier_snapshot_rows'::pg_catalog.regclass,
    (
      SELECT attribute.attnum
      FROM pg_catalog.pg_attribute AS attribute
      WHERE attribute.attrelid =
          'arena.copier_snapshot_rows'::pg_catalog.regclass
        AND attribute.attname = 'source_event_at'
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
    )
  );

  v_existing_hardening :=
    v_guard IS NOT NULL
    OR v_normalizer IS NOT NULL
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_trigger AS trigger
      WHERE trigger.tgrelid IN (
        'arena.copier_snapshot_publications'::pg_catalog.regclass,
        'arena.copier_snapshot_rows'::pg_catalog.regclass
      )
        AND NOT trigger.tgisinternal
        AND trigger.tgname IN (
          'copier_snapshot_publication_guard_insert_v1',
          'copier_snapshot_row_normalize_source_event_v1'
        )
    )
    OR NOT v_source_event_not_null;

  IF NOT v_existing_hardening THEN
    IF v_source_event_comment IS DISTINCT FROM
         'Upstream follower/event timestamp only; never a snapshot or publication clock.' THEN
      RAISE EXCEPTION 'copier snapshot source_event_at pre-state comment drifted';
    END IF;
  ELSE
    IF v_source_event_not_null
       OR v_guard IS NULL
       OR v_normalizer IS NULL
       OR v_source_event_comment IS DISTINCT FROM
         'V1 copier receipts do not prove an upstream source-event timestamp. The publisher row ts is an acquisition clock retained only in immutable request/RAW evidence; this projection is normalized to NULL.' THEN
      RAISE EXCEPTION 'copier snapshot provenance hardening is partial or drifted';
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS procedure
      WHERE procedure.oid = v_guard
        AND procedure.proowner = 'postgres'::pg_catalog.regrole
        AND NOT procedure.prosecdef
        AND procedure.provolatile = 'v'
        AND procedure.proconfig IS NOT DISTINCT FROM
            ARRAY['search_path=pg_catalog, pg_temp']::text[]
        AND pg_catalog.strpos(
          procedure.prosrc,
          'FOR SHARE OF source_row, trader_row'
        ) > 0
        AND pg_catalog.strpos(
          procedure.prosrc,
          'statement_timestamp() + interval ''5 minutes'''
        ) > 0
        AND pg_catalog.strpos(
          procedure.prosrc,
          'claimed trader copier snapshots cannot be published'
        ) > 0
        AND pg_catalog.strpos(
          procedure.prosrc,
          'v_distribution_total < 10'
        ) > 0
        AND pg_catalog.strpos(
          procedure.prosrc,
          'NEW.pnl_distribution := ''[]''::pg_catalog.jsonb'
        ) > 0
    ) OR NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS procedure
      WHERE procedure.oid = v_normalizer
        AND procedure.proowner = 'postgres'::pg_catalog.regrole
        AND NOT procedure.prosecdef
        AND procedure.provolatile = 'v'
        AND procedure.proconfig IS NOT DISTINCT FROM
            ARRAY['search_path=pg_catalog, pg_temp']::text[]
        AND pg_catalog.strpos(
          procedure.prosrc,
          'NEW.source_event_at := NULL'
        ) > 0
    ) OR (
      SELECT pg_catalog.count(*)
      FROM pg_catalog.pg_proc AS procedure
      JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.oid = procedure.pronamespace
      WHERE namespace.nspname = 'arena'
        AND procedure.proname IN (
          'guard_copier_snapshot_publication_insert_v1',
          'normalize_copier_snapshot_row_source_event_v1'
        )
    ) <> 2
    OR pg_catalog.has_function_privilege('anon', v_guard, 'EXECUTE')
    OR pg_catalog.has_function_privilege(
      'authenticated', v_guard, 'EXECUTE'
    )
    OR pg_catalog.has_function_privilege(
      'service_role', v_guard, 'EXECUTE'
    )
    OR pg_catalog.has_function_privilege('anon', v_normalizer, 'EXECUTE')
    OR pg_catalog.has_function_privilege(
      'authenticated', v_normalizer, 'EXECUTE'
    )
    OR pg_catalog.has_function_privilege(
      'service_role', v_normalizer, 'EXECUTE'
    )
    OR NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_trigger AS trigger
      WHERE trigger.tgrelid =
          'arena.copier_snapshot_publications'::pg_catalog.regclass
        AND trigger.tgname =
          'copier_snapshot_publication_guard_insert_v1'
        AND trigger.tgfoid = v_guard
        AND trigger.tgtype = 7
        AND trigger.tgenabled = 'O'
        AND NOT trigger.tgisinternal
    ) OR NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_trigger AS trigger
      WHERE trigger.tgrelid =
          'arena.copier_snapshot_rows'::pg_catalog.regclass
        AND trigger.tgname =
          'copier_snapshot_row_normalize_source_event_v1'
        AND trigger.tgfoid = v_normalizer
        AND trigger.tgtype = 7
        AND trigger.tgenabled = 'O'
        AND NOT trigger.tgisinternal
    ) THEN
      RAISE EXCEPTION 'copier snapshot provenance hardening replay lineage drifted';
    END IF;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger
    WHERE trigger.tgrelid =
        'arena.copier_snapshot_publications'::pg_catalog.regclass
      AND NOT trigger.tgisinternal
      AND (trigger.tgtype & 2) = 2
      AND (trigger.tgtype & 4) = 4
      AND trigger.tgname <> 'copier_snapshot_publication_guard_insert_v1'
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger
    WHERE trigger.tgrelid =
        'arena.copier_snapshot_rows'::pg_catalog.regclass
      AND NOT trigger.tgisinternal
      AND (trigger.tgtype & 2) = 2
      AND (trigger.tgtype & 4) = 4
      AND trigger.tgname <> 'copier_snapshot_row_normalize_source_event_v1'
  ) THEN
    RAISE EXCEPTION 'unexpected copier snapshot BEFORE INSERT trigger would make admission order ambiguous';
  END IF;
END
$locked_preflight$;

ALTER TABLE arena.copier_snapshot_rows
  ALTER COLUMN source_event_at DROP NOT NULL;

COMMENT ON COLUMN arena.copier_snapshot_rows.source_event_at IS
  'V1 copier receipts do not prove an upstream source-event timestamp. The publisher row ts is an acquisition clock retained only in immutable request/RAW evidence; this projection is normalized to NULL.';

CREATE OR REPLACE FUNCTION arena.guard_copier_snapshot_publication_insert_v1()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_allowed_buckets constant text[] := ARRAY[
    '<-1000',
    '-1000~0',
    '0~1000',
    '1000~10000',
    '>10000'
  ]::text[];
  v_expected_bucket_keys constant text[] := ARRAY[
    'bucket',
    'count'
  ]::text[];
  v_status text;
  v_serving_mode text;
  v_depth text;
  v_currency text;
  v_trader_meta jsonb;
  v_bucket jsonb;
  v_bucket_keys text[];
  v_bucket_name text;
  v_bucket_count numeric;
  v_bucket_index integer;
  v_previous_bucket_index integer := 0;
  v_distribution_total numeric := 0;
  v_distribution_valid boolean := true;
BEGIN
  IF NEW.observed_at IS NULL
     OR NOT pg_catalog.isfinite(NEW.observed_at)
     OR NEW.observed_at >
        pg_catalog.statement_timestamp() + interval '5 minutes' THEN
    RAISE EXCEPTION 'copier snapshot observed_at exceeds the database publication clock'
      USING ERRCODE = '22023';
  END IF;

  SELECT
    source_row.status,
    source_row.serving_mode,
    source_row.copier_table_depth,
    source_row.currency,
    trader_row.meta
  INTO
    v_status,
    v_serving_mode,
    v_depth,
    v_currency,
    v_trader_meta
  FROM arena.sources AS source_row
  JOIN arena.traders AS trader_row
    ON trader_row.source_id = source_row.id
  WHERE source_row.id = NEW.source_id
    AND trader_row.id = NEW.trader_id
  FOR SHARE OF source_row, trader_row;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'copier snapshot subject is not one exact source/trader pair'
      USING ERRCODE = '55000';
  END IF;

  IF v_status IS DISTINCT FROM 'active'
     OR v_serving_mode IS DISTINCT FROM 'serving'
     OR v_depth NOT IN ('full', 'top10', 'top3_preview')
     OR NEW.source_depth IS DISTINCT FROM v_depth
     OR NEW.currency IS DISTINCT FROM v_currency THEN
    RAISE EXCEPTION 'copier snapshot source is not active serving or its publication contract drifted'
      USING ERRCODE = '55000';
  END IF;

  IF v_trader_meta->>'claimed' = 'true' THEN
    RAISE EXCEPTION 'claimed trader copier snapshots cannot be published'
      USING ERRCODE = '55000';
  END IF;

  -- The 054000 publisher originally gated histogram release on total rows,
  -- not on the number of rows that actually contributed a non-null PnL. A
  -- ten-row snapshot with only five contributing rows could therefore expose
  -- a cohort of five. Normalize every unsafe or non-canonical projection to
  -- the privacy-preserving empty array before it becomes immutable.
  IF NEW.pnl_distribution IS NULL
     OR pg_catalog.jsonb_typeof(NEW.pnl_distribution) IS DISTINCT FROM
        'array'
     OR pg_catalog.jsonb_array_length(NEW.pnl_distribution) > 5 THEN
    v_distribution_valid := false;
  ELSIF pg_catalog.jsonb_array_length(NEW.pnl_distribution) > 0 THEN
    FOR v_bucket IN
      SELECT bucket_value
      FROM pg_catalog.jsonb_array_elements(
        NEW.pnl_distribution
      ) AS bucket(bucket_value)
    LOOP
      IF pg_catalog.jsonb_typeof(v_bucket) IS DISTINCT FROM 'object'
         OR pg_catalog.jsonb_typeof(v_bucket->'bucket') IS DISTINCT FROM
            'string'
         OR pg_catalog.jsonb_typeof(v_bucket->'count') IS DISTINCT FROM
            'number' THEN
        v_distribution_valid := false;
        EXIT;
      END IF;

      SELECT pg_catalog.array_agg(key_name ORDER BY key_name)
      INTO v_bucket_keys
      FROM pg_catalog.jsonb_object_keys(v_bucket) AS key_name;
      IF v_bucket_keys IS DISTINCT FROM v_expected_bucket_keys THEN
        v_distribution_valid := false;
        EXIT;
      END IF;

      v_bucket_name := v_bucket->>'bucket';
      v_bucket_index := pg_catalog.array_position(
        v_allowed_buckets,
        v_bucket_name
      );
      IF v_bucket_index IS NULL
         OR v_bucket_index <= v_previous_bucket_index THEN
        v_distribution_valid := false;
        EXIT;
      END IF;

      v_bucket_count := NULL;
      BEGIN
        v_bucket_count := (v_bucket->>'count')::numeric;
      EXCEPTION WHEN OTHERS THEN
        v_distribution_valid := false;
      END;
      IF NOT v_distribution_valid
         OR v_bucket_count <> pg_catalog.trunc(v_bucket_count)
         OR v_bucket_count < 5
         OR v_bucket_count > 10000000 THEN
        v_distribution_valid := false;
        EXIT;
      END IF;

      v_previous_bucket_index := v_bucket_index;
      v_distribution_total := v_distribution_total + v_bucket_count;
    END LOOP;

    IF v_distribution_total < 10
       OR NEW.copier_count IS NULL
       OR NEW.copier_count NOT BETWEEN 0 AND 10000000
       OR v_distribution_total > NEW.copier_count THEN
      v_distribution_valid := false;
    END IF;
  END IF;

  IF NOT v_distribution_valid THEN
    NEW.pnl_distribution := '[]'::pg_catalog.jsonb;
  END IF;

  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION arena.normalize_copier_snapshot_row_source_event_v1()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  NEW.source_event_at := NULL;
  RETURN NEW;
END
$function$;

ALTER FUNCTION arena.guard_copier_snapshot_publication_insert_v1()
  OWNER TO postgres;
ALTER FUNCTION arena.normalize_copier_snapshot_row_source_event_v1()
  OWNER TO postgres;

REVOKE ALL ON FUNCTION arena.guard_copier_snapshot_publication_insert_v1()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.normalize_copier_snapshot_row_source_event_v1()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS copier_snapshot_publication_guard_insert_v1
  ON arena.copier_snapshot_publications;
CREATE TRIGGER copier_snapshot_publication_guard_insert_v1
BEFORE INSERT ON arena.copier_snapshot_publications
FOR EACH ROW
EXECUTE FUNCTION arena.guard_copier_snapshot_publication_insert_v1();

DROP TRIGGER IF EXISTS copier_snapshot_row_normalize_source_event_v1
  ON arena.copier_snapshot_rows;
CREATE TRIGGER copier_snapshot_row_normalize_source_event_v1
BEFORE INSERT ON arena.copier_snapshot_rows
FOR EACH ROW
EXECUTE FUNCTION arena.normalize_copier_snapshot_row_source_event_v1();

DO $postflight$
DECLARE
  v_guard oid := pg_catalog.to_regprocedure(
    'arena.guard_copier_snapshot_publication_insert_v1()'
  );
  v_normalizer oid := pg_catalog.to_regprocedure(
    'arena.normalize_copier_snapshot_row_source_event_v1()'
  );
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid =
        'arena.copier_snapshot_rows'::pg_catalog.regclass
      AND attribute.attname = 'source_event_at'
      AND attribute.attnotnull
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  ) OR pg_catalog.col_description(
    'arena.copier_snapshot_rows'::pg_catalog.regclass,
    (
      SELECT attribute.attnum
      FROM pg_catalog.pg_attribute AS attribute
      WHERE attribute.attrelid =
          'arena.copier_snapshot_rows'::pg_catalog.regclass
        AND attribute.attname = 'source_event_at'
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
    )
  ) IS DISTINCT FROM
    'V1 copier receipts do not prove an upstream source-event timestamp. The publisher row ts is an acquisition clock retained only in immutable request/RAW evidence; this projection is normalized to NULL.' THEN
    RAISE EXCEPTION 'copier snapshot source-event provenance postflight failed';
  END IF;

  IF v_guard IS NULL
     OR v_normalizer IS NULL
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS procedure
       WHERE procedure.oid = v_guard
         AND procedure.proowner = 'postgres'::pg_catalog.regrole
         AND NOT procedure.prosecdef
         AND procedure.provolatile = 'v'
         AND procedure.proconfig IS NOT DISTINCT FROM
             ARRAY['search_path=pg_catalog, pg_temp']::text[]
     )
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS procedure
       WHERE procedure.oid = v_normalizer
         AND procedure.proowner = 'postgres'::pg_catalog.regrole
         AND NOT procedure.prosecdef
         AND procedure.provolatile = 'v'
         AND procedure.proconfig IS NOT DISTINCT FROM
             ARRAY['search_path=pg_catalog, pg_temp']::text[]
     )
     OR pg_catalog.has_function_privilege(
       'anon', v_guard, 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'authenticated', v_guard, 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'service_role', v_guard, 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'anon', v_normalizer, 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'authenticated', v_normalizer, 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'service_role', v_normalizer, 'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'copier snapshot provenance function ACL postflight failed';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_trigger AS trigger
    WHERE NOT trigger.tgisinternal
      AND trigger.tgenabled = 'O'
      AND (
        (
          trigger.tgrelid =
            'arena.copier_snapshot_publications'::pg_catalog.regclass
          AND trigger.tgname =
            'copier_snapshot_publication_guard_insert_v1'
          AND trigger.tgfoid = v_guard
          AND (trigger.tgtype & 1) = 1
          AND (trigger.tgtype & 2) = 2
          AND (trigger.tgtype & 4) = 4
        ) OR (
          trigger.tgrelid =
            'arena.copier_snapshot_rows'::pg_catalog.regclass
          AND trigger.tgname =
            'copier_snapshot_row_normalize_source_event_v1'
          AND trigger.tgfoid = v_normalizer
          AND (trigger.tgtype & 1) = 1
          AND (trigger.tgtype & 2) = 2
          AND (trigger.tgtype & 4) = 4
        )
      )
  ) <> 2 THEN
    RAISE EXCEPTION 'copier snapshot provenance trigger postflight failed';
  END IF;

  IF pg_catalog.has_table_privilege(
       'anon', 'arena.copier_snapshot_publications', 'SELECT,INSERT,UPDATE,DELETE'
     )
     OR pg_catalog.has_table_privilege(
       'authenticated',
       'arena.copier_snapshot_publications',
       'SELECT,INSERT,UPDATE,DELETE'
     )
     OR pg_catalog.has_table_privilege(
       'service_role',
       'arena.copier_snapshot_publications',
       'SELECT,INSERT,UPDATE,DELETE'
     )
     OR pg_catalog.has_table_privilege(
       'anon', 'arena.copier_snapshot_rows', 'SELECT,INSERT,UPDATE,DELETE'
     )
     OR pg_catalog.has_table_privilege(
       'authenticated',
       'arena.copier_snapshot_rows',
       'SELECT,INSERT,UPDATE,DELETE'
     )
     OR pg_catalog.has_table_privilege(
       'service_role',
       'arena.copier_snapshot_rows',
       'SELECT,INSERT,UPDATE,DELETE'
     ) THEN
    RAISE EXCEPTION 'copier snapshot private table ACL postflight failed';
  END IF;
END
$postflight$;

COMMIT;
