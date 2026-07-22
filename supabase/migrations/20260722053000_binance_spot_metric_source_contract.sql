-- Migration: 20260722053000_binance_spot_metric_source_contract.sql
-- Created: 2026-07-22T05:30:00Z
-- Description: Register the two reviewed Binance Spot population fields as
--   source-reported provenance. Registration is not window, population, or
--   rank authority: Spot remains outside serving until separate capture and
--   live canary evidence prove every metric-trust gate.

BEGIN;

SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $foundations$
BEGIN
  IF pg_catalog.current_setting('server_version_num')::integer / 10000 <> 17 THEN
    RAISE EXCEPTION 'Binance Spot metric source contract requires PostgreSQL 17';
  END IF;

  IF pg_catalog.to_regclass('arena.exchanges') IS NULL
     OR pg_catalog.to_regclass('arena.sources') IS NULL
     OR pg_catalog.to_regclass('arena.metric_source_contracts') IS NULL THEN
    RAISE EXCEPTION 'Binance Spot metric source contract foundations are missing';
  END IF;

  IF pg_catalog.to_regrole('service_role') IS NULL
     OR pg_catalog.to_regrole('anon') IS NULL
     OR pg_catalog.to_regrole('authenticated') IS NULL THEN
    RAISE EXCEPTION 'Binance Spot metric source contract roles are missing';
  END IF;
END
$foundations$;

-- Contract rows are append-only. Serialize the absence check with this insert
-- so two deployment channels cannot register different Spot contracts.
LOCK TABLE arena.metric_source_contracts IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
DECLARE
  v_source arena.sources%ROWTYPE;
  v_exchange_slug text;
  v_mutation_triggers bigint;
  v_reject_oid pg_catalog.regprocedure := pg_catalog.to_regprocedure(
    'arena.reject_direct_metric_trust_mutation()'
  );
  v_registry_oid pg_catalog.oid :=
    'arena.metric_source_contracts'::pg_catalog.regclass;
  v_registry_owner pg_catalog.oid;
  v_service_role pg_catalog.oid := pg_catalog.to_regrole('service_role');
BEGIN
  IF (SELECT pg_catalog.count(*)
        FROM arena.sources
       WHERE slug = 'binance_spot') <> 1 THEN
    RAISE EXCEPTION 'expected exactly one Binance Spot source row';
  END IF;

  SELECT source.*
    INTO STRICT v_source
    FROM arena.sources AS source
   WHERE source.slug = 'binance_spot'
   FOR SHARE;

  SELECT exchange.slug
    INTO STRICT v_exchange_slug
    FROM arena.exchanges AS exchange
   WHERE exchange.id = v_source.exchange_id
   FOR SHARE;

  IF v_exchange_slug IS DISTINCT FROM 'binance'
     OR v_source.adapter_slug IS DISTINCT FROM 'binance'
     OR v_source.product_type IS DISTINCT FROM 'spot'
     OR v_source.trader_kind_scope IS DISTINCT FROM 'human'
     OR v_source.currency IS DISTINCT FROM 'USDT'
     OR v_source.copier_table_depth IS DISTINCT FROM 'full'
     OR v_source.page_size IS DISTINCT FROM 20
     OR v_source.pagination_kind IS DISTINCT FROM 'numeric'
     OR v_source.fetch_region IS DISTINCT FROM 'vps_sg'
     OR v_source.timeframes_native IS DISTINCT FROM ARRAY[7, 30, 90]::integer[]
     OR v_source.timeframes_derived IS DISTINCT FROM ARRAY[]::integer[]
     OR pg_catalog.jsonb_typeof(v_source.meta) IS DISTINCT FROM 'object'
     OR v_source.meta->>'boardKey' IS DISTINCT FROM 'spot'
     OR v_source.meta->'click_all_portfolios' IS DISTINCT FROM 'true'::jsonb
     OR v_source.meta->'position_history_dual_sort' IS DISTINCT FROM 'true'::jsonb THEN
    RAISE EXCEPTION 'Binance Spot source registry drifted from the reviewed board contract';
  END IF;

  -- This migration may add provenance to an inactive or shadow source, but it
  -- must never grant a contract to a source that is already publicly serving.
  IF v_source.serving_mode = 'serving' OR v_source.status = 'dropped' THEN
    RAISE EXCEPTION 'Binance Spot must be non-serving and non-dropped before contract registration';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM arena.metric_source_contracts AS contract
     WHERE contract.source_id = v_source.id
  ) THEN
    RAISE EXCEPTION 'Binance Spot already has metric source contracts; refusing ambiguous append';
  END IF;

  IF NOT EXISTS (
       SELECT 1
         FROM pg_catalog.pg_constraint AS constraint_row
        WHERE constraint_row.conrelid =
              'arena.metric_source_contracts'::pg_catalog.regclass
          AND constraint_row.contype = 'f'
          AND constraint_row.convalidated
          AND constraint_row.confrelid = 'arena.sources'::pg_catalog.regclass
          AND constraint_row.confdeltype = 'r'
          AND constraint_row.conkey = ARRAY[
                (
                  SELECT attribute.attnum
                    FROM pg_catalog.pg_attribute AS attribute
                   WHERE attribute.attrelid =
                         'arena.metric_source_contracts'::pg_catalog.regclass
                     AND attribute.attname = 'source_id'
                     AND NOT attribute.attisdropped
                )
              ]::smallint[]
          AND constraint_row.confkey = ARRAY[
                (
                  SELECT attribute.attnum
                    FROM pg_catalog.pg_attribute AS attribute
                   WHERE attribute.attrelid = 'arena.sources'::pg_catalog.regclass
                     AND attribute.attname = 'id'
                     AND NOT attribute.attisdropped
                )
              ]::smallint[]
     )
     OR NOT EXISTS (
       SELECT 1
         FROM pg_catalog.pg_constraint AS constraint_row
        WHERE constraint_row.conrelid =
              'arena.metric_source_contracts'::pg_catalog.regclass
          AND constraint_row.contype = 'u'
          AND constraint_row.convalidated
          AND constraint_row.conkey = ARRAY[
                (
                  SELECT attribute.attnum FROM pg_catalog.pg_attribute AS attribute
                   WHERE attribute.attrelid = 'arena.metric_source_contracts'::pg_catalog.regclass
                     AND attribute.attname = 'source_id' AND NOT attribute.attisdropped
                ),
                (
                  SELECT attribute.attnum FROM pg_catalog.pg_attribute AS attribute
                   WHERE attribute.attrelid = 'arena.metric_source_contracts'::pg_catalog.regclass
                     AND attribute.attname = 'contract_version' AND NOT attribute.attisdropped
                ),
                (
                  SELECT attribute.attnum FROM pg_catalog.pg_attribute AS attribute
                   WHERE attribute.attrelid = 'arena.metric_source_contracts'::pg_catalog.regclass
                     AND attribute.attname = 'metric' AND NOT attribute.attisdropped
                ),
                (
                  SELECT attribute.attnum FROM pg_catalog.pg_attribute AS attribute
                   WHERE attribute.attrelid = 'arena.metric_source_contracts'::pg_catalog.regclass
                     AND attribute.attname = 'field_path' AND NOT attribute.attisdropped
                ),
                (
                  SELECT attribute.attnum FROM pg_catalog.pg_attribute AS attribute
                   WHERE attribute.attrelid = 'arena.metric_source_contracts'::pg_catalog.regclass
                     AND attribute.attname = 'provenance' AND NOT attribute.attisdropped
                ),
                (
                  SELECT attribute.attnum FROM pg_catalog.pg_attribute AS attribute
                   WHERE attribute.attrelid = 'arena.metric_source_contracts'::pg_catalog.regclass
                     AND attribute.attname = 'methodology_version' AND NOT attribute.attisdropped
                )
              ]::smallint[]
     ) THEN
    RAISE EXCEPTION 'metric source contract foreign-key or uniqueness boundary drifted';
  END IF;

  SELECT class_row.relowner
    INTO STRICT v_registry_owner
    FROM pg_catalog.pg_class AS class_row
   WHERE class_row.oid = v_registry_oid;

  IF v_reject_oid IS NULL
     OR NOT EXISTS (
       SELECT 1
         FROM pg_catalog.pg_proc AS function_row
        WHERE function_row.oid = v_reject_oid
          AND function_row.prorettype = 'trigger'::pg_catalog.regtype
          AND function_row.provolatile = 'v'
          AND NOT function_row.prosecdef
          AND function_row.proconfig @> ARRAY[
                'search_path=pg_catalog, pg_temp'
              ]::text[]
          AND pg_catalog.md5(
                pg_catalog.pg_get_functiondef(function_row.oid)
              ) = '8f33c3e101839453d73bcb99156e4f2a'
     ) THEN
    RAISE EXCEPTION 'metric source contract reject function drifted';
  END IF;

  SELECT pg_catalog.count(*)
    INTO v_mutation_triggers
    FROM pg_catalog.pg_trigger AS trigger_row
   WHERE trigger_row.tgrelid =
         'arena.metric_source_contracts'::pg_catalog.regclass
     AND NOT trigger_row.tgisinternal
     AND trigger_row.tgenabled = 'O'
     AND trigger_row.tgfoid = v_reject_oid
     AND trigger_row.tgqual IS NULL
     AND trigger_row.tgconstraint = 0
     AND NOT trigger_row.tgdeferrable
     AND NOT trigger_row.tginitdeferred
     AND trigger_row.tgnargs = 0
     AND pg_catalog.octet_length(trigger_row.tgargs) = 0
     AND trigger_row.tgattr = ''::pg_catalog.int2vector
     AND (
       (
         trigger_row.tgname = 'metric_source_contracts_reject_direct_mutation'
         AND trigger_row.tgtype = 27
       )
       OR (
         trigger_row.tgname = 'metric_source_contracts_reject_truncate'
         AND trigger_row.tgtype = 34
       )
     );

  IF v_mutation_triggers <> 2
     OR (
       SELECT pg_catalog.count(*)
         FROM pg_catalog.pg_trigger AS trigger_row
        WHERE trigger_row.tgrelid = v_registry_oid
          AND NOT trigger_row.tgisinternal
     ) <> 2
     OR (
       SELECT pg_catalog.count(*)
         FROM pg_catalog.pg_trigger AS trigger_row
        WHERE trigger_row.tgrelid = v_registry_oid
          AND NOT trigger_row.tgisinternal
          AND trigger_row.tgenabled = 'O'
          AND trigger_row.tgfoid = v_reject_oid
     ) <> 2
     OR NOT (
       SELECT class_row.relrowsecurity
         FROM pg_catalog.pg_class AS class_row
        WHERE class_row.oid =
              'arena.metric_source_contracts'::pg_catalog.regclass
     )
     OR NOT pg_catalog.has_table_privilege(
       'service_role', 'arena.metric_source_contracts', 'SELECT'
     )
     OR pg_catalog.has_table_privilege(
       'service_role', 'arena.metric_source_contracts', 'INSERT'
     )
     OR pg_catalog.has_table_privilege(
       'service_role', 'arena.metric_source_contracts', 'UPDATE'
     )
     OR pg_catalog.has_table_privilege(
       'service_role', 'arena.metric_source_contracts', 'DELETE'
     )
     OR pg_catalog.has_table_privilege(
       'service_role', 'arena.metric_source_contracts', 'TRUNCATE'
     )
     OR EXISTS (
       SELECT 1
         FROM (VALUES ('anon'::text), ('authenticated'::text)) AS role_name(name)
         CROSS JOIN (
           VALUES
             ('SELECT'::text),
             ('INSERT'::text),
             ('UPDATE'::text),
             ('DELETE'::text),
             ('TRUNCATE'::text),
             ('REFERENCES'::text),
             ('TRIGGER'::text)
         ) AS privilege_name(name)
        WHERE pg_catalog.has_table_privilege(
          role_name.name,
          'arena.metric_source_contracts',
          privilege_name.name
        )
     )
     OR EXISTS (
       SELECT 1
         FROM pg_catalog.pg_class AS class_row
         CROSS JOIN LATERAL pg_catalog.aclexplode(
           COALESCE(
             class_row.relacl,
             pg_catalog.acldefault('r', class_row.relowner)
           )
         ) AS privilege_row
        WHERE class_row.oid = v_registry_oid
          AND privilege_row.grantee NOT IN (v_registry_owner, v_service_role)
     )
     OR EXISTS (
       SELECT 1
         FROM pg_catalog.pg_class AS class_row
         CROSS JOIN LATERAL pg_catalog.aclexplode(
           COALESCE(
             class_row.relacl,
             pg_catalog.acldefault('r', class_row.relowner)
           )
         ) AS privilege_row
        WHERE class_row.oid = v_registry_oid
          AND privilege_row.grantee = v_service_role
          AND privilege_row.privilege_type <> 'SELECT'
     )
     OR EXISTS (
       SELECT 1
         FROM pg_catalog.pg_policy AS policy_row
        WHERE policy_row.polrelid = v_registry_oid
     ) THEN
    RAISE EXCEPTION 'metric source contract append-only or ACL boundary drifted';
  END IF;
END
$preflight$;

-- These rows record field provenance only. They do not prove population,
-- window, quality, price, cost basis, freshness, or rank eligibility.
DO $register$
DECLARE
  v_inserted integer;
BEGIN
  INSERT INTO arena.metric_source_contracts (
    source_id,
    contract_version,
    metric,
    field_path,
    provenance,
    methodology_version,
    metric_set_id,
    timeframes,
    value_unit,
    currencies,
    required_raw_roles,
    source_payload_scope,
    max_freshness,
    max_window_end_lag,
    allow_derived_population,
    active
  )
  SELECT
    source.id,
    contract.contract_version,
    contract.metric,
    contract.field_path,
    contract.provenance,
    contract.methodology_version,
    contract.metric_set_id,
    contract.timeframes,
    contract.value_unit,
    contract.currencies,
    contract.required_raw_roles,
    contract.source_payload_scope,
    contract.max_freshness,
    contract.max_window_end_lag,
    false,
    true
  FROM arena.sources AS source
  CROSS JOIN (
    VALUES
      (
        '1'::text,
        'roi'::text,
        'data.list[].roi'::text,
        'source_reported'::text,
        'binance-board-roi@1'::text,
        'binance-board-roi-pnl@1'::text,
        ARRAY[7, 30, 90]::smallint[],
        'percent'::text,
        ARRAY['USDT']::text[],
        ARRAY['source_payload', 'population_manifest']::text[],
        'population_snapshot'::text,
        interval '6 hours',
        interval '5 minutes'
      ),
      (
        '1',
        'pnl',
        'data.list[].pnl',
        'source_reported',
        'binance-board-pnl@1',
        'binance-board-roi-pnl@1',
        ARRAY[7, 30, 90]::smallint[],
        'currency',
        ARRAY['USDT']::text[],
        ARRAY['source_payload', 'population_manifest']::text[],
        'population_snapshot',
        interval '6 hours',
        interval '5 minutes'
      )
  ) AS contract(
    contract_version,
    metric,
    field_path,
    provenance,
    methodology_version,
    metric_set_id,
    timeframes,
    value_unit,
    currencies,
    required_raw_roles,
    source_payload_scope,
    max_freshness,
    max_window_end_lag
  )
  WHERE source.slug = 'binance_spot';

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF v_inserted <> 2 THEN
    RAISE EXCEPTION 'expected exactly two Binance Spot population contracts';
  END IF;
END
$register$;

DO $postflight$
DECLARE
  v_source_id smallint;
  v_total bigint;
  v_drift boolean;
BEGIN
  SELECT source.id
    INTO STRICT v_source_id
    FROM arena.sources AS source
   WHERE source.slug = 'binance_spot'
     AND source.serving_mode <> 'serving'
     AND source.status <> 'dropped';

  SELECT pg_catalog.count(*)
    INTO v_total
    FROM arena.metric_source_contracts AS contract
   WHERE contract.source_id = v_source_id;

  WITH expected(
    contract_version,
    metric,
    field_path,
    provenance,
    methodology_version,
    metric_set_id,
    timeframes,
    value_unit,
    currencies,
    required_raw_roles,
    source_payload_scope,
    max_freshness,
    max_window_end_lag,
    allow_derived_population,
    active
  ) AS (
    VALUES
      (
        '1'::text,
        'roi'::text,
        'data.list[].roi'::text,
        'source_reported'::text,
        'binance-board-roi@1'::text,
        'binance-board-roi-pnl@1'::text,
        ARRAY[7, 30, 90]::smallint[],
        'percent'::text,
        ARRAY['USDT']::text[],
        ARRAY['source_payload', 'population_manifest']::text[],
        'population_snapshot'::text,
        interval '6 hours',
        interval '5 minutes',
        false,
        true
      ),
      (
        '1'::text,
        'pnl'::text,
        'data.list[].pnl'::text,
        'source_reported'::text,
        'binance-board-pnl@1'::text,
        'binance-board-roi-pnl@1'::text,
        ARRAY[7, 30, 90]::smallint[],
        'currency'::text,
        ARRAY['USDT']::text[],
        ARRAY['source_payload', 'population_manifest']::text[],
        'population_snapshot'::text,
        interval '6 hours',
        interval '5 minutes',
        false,
        true
      )
  ), actual AS (
    SELECT
      contract.contract_version,
      contract.metric,
      contract.field_path,
      contract.provenance,
      contract.methodology_version,
      contract.metric_set_id,
      contract.timeframes,
      contract.value_unit,
      contract.currencies,
      contract.required_raw_roles,
      contract.source_payload_scope,
      contract.max_freshness,
      contract.max_window_end_lag,
      contract.allow_derived_population,
      contract.active
    FROM arena.metric_source_contracts AS contract
    WHERE contract.source_id = v_source_id
  )
  SELECT EXISTS (
    (SELECT * FROM actual EXCEPT ALL SELECT * FROM expected)
    UNION ALL
    (SELECT * FROM expected EXCEPT ALL SELECT * FROM actual)
  )
    INTO v_drift;

  IF v_total <> 2 OR v_drift THEN
    RAISE EXCEPTION 'Binance Spot population contract postflight drifted';
  END IF;
END
$postflight$;

COMMIT;
