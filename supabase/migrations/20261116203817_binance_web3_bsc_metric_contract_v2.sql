-- Migration: 20261116203817_binance_web3_bsc_metric_contract_v2.sql
-- Created: 2026-11-16T20:38:17Z
-- Description: Move binance_web3_bsc to metric contract version 2 and retire
--   version 1, in one reviewed step.
--
-- The attempt-bound capture (#482) stores the upstream board response
-- verbatim, so the headline fields sit at data.data[] (v1, seeded by
-- 20260721120000, read the legacy composite board.data.data[]). With v1 still
-- current, every attempt-bound observation recorded field_lineage_mismatch.
-- Version 2 mirrors lib/metric-trust.ts exactly: the two board fields move to
-- data.data[], the arena_rebuilt rebuild.roi field is carried unchanged, and
-- every other column equals v1. Version 1 is then retired through
-- arena.metric_source_contract_retirements (20261116203816); its rows and the
-- observations that cite them stay as they are.
--
-- POSTDEPLOY, after 20261116204359 and before 20261111192134. The deployed
-- worker before this release reads v1 (it would see v1 retired and v2 current
-- and fail its contract parity check for this source), so this runs after the
-- worker whose registry holds v2. Until it runs, that worker fails the same
-- check for binance_web3_bsc only; no other source is affected. It needs the
-- retirement mechanism (predeploy 20261116203816) and binance_web3_bsc in USD
-- (postdeploy 20261115160917).
--
-- A missing binance_web3_bsc is skipped. An existing one must use the
-- binance_web3 adapter and USD, and its only current version must be v1 with
-- exactly the reviewed fields; otherwise, and on replay, the migration refuses.
--
-- Generated only; not applied to any environment.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL search_path = pg_catalog, pg_temp;

DO $preflight$
BEGIN
  IF pg_catalog.to_regclass('arena.metric_source_contract_retirements') IS NULL
     OR pg_catalog.to_regprocedure(
       'arena.assert_single_current_metric_source_contract_version()'
     ) IS NULL THEN
    RAISE EXCEPTION 'binance_web3_bsc contract v2 requires the metric source contract retirement mechanism (20261116203816)';
  END IF;
END
$preflight$;

LOCK TABLE arena.sources IN SHARE MODE;
LOCK TABLE arena.metric_source_contracts IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE arena.metric_source_contract_retirements IN SHARE ROW EXCLUSIVE MODE;

-- Session-local seeds (pg_temp); they disappear with the applying session.
CREATE TEMPORARY TABLE bsc_contract_seed (
  contract_version text NOT NULL,
  metric text NOT NULL,
  field_path text NOT NULL,
  provenance text NOT NULL,
  methodology_version text NOT NULL,
  metric_set_id text NOT NULL,
  required_raw_roles text[] NOT NULL,
  source_payload_scope text NOT NULL,
  PRIMARY KEY (contract_version, metric, field_path)
);

-- Shared by every row of both versions: timeframes {7,30,90}, USD, freshness
-- 2 hours, window-end lag 5 minutes, no derived population.
INSERT INTO bsc_contract_seed VALUES
  ('1', 'roi', 'board.data.data[].realizedPnlPercent', 'source_reported',
   'binance-web3-board-realized-pnl-percent@1', 'binance-web3-board-realized-pnl@1',
   ARRAY['source_payload', 'population_manifest'], 'population_snapshot'),
  ('1', 'pnl', 'board.data.data[].realizedPnl', 'source_reported',
   'binance-web3-board-realized-pnl@1', 'binance-web3-board-realized-pnl@1',
   ARRAY['source_payload', 'population_manifest'], 'population_snapshot'),
  ('1', 'roi', 'rebuild.roi', 'arena_rebuilt',
   'wallet-event-ledger-average-cost@1', 'wallet-event-ledger-average-cost@1',
   ARRAY['event_history', 'price_history', 'opening_inventory', 'population_manifest'],
   'not_required'),
  ('2', 'roi', 'data.data[].realizedPnlPercent', 'source_reported',
   'binance-web3-board-realized-pnl-percent@1', 'binance-web3-board-realized-pnl@1',
   ARRAY['source_payload', 'population_manifest'], 'population_snapshot'),
  ('2', 'pnl', 'data.data[].realizedPnl', 'source_reported',
   'binance-web3-board-realized-pnl@1', 'binance-web3-board-realized-pnl@1',
   ARRAY['source_payload', 'population_manifest'], 'population_snapshot'),
  ('2', 'roi', 'rebuild.roi', 'arena_rebuilt',
   'wallet-event-ledger-average-cost@1', 'wallet-event-ledger-average-cost@1',
   ARRAY['event_history', 'price_history', 'opening_inventory', 'population_manifest'],
   'not_required');

-- The reviewed rows of one version, as comparable text.
CREATE TEMPORARY VIEW bsc_contract_rows AS
SELECT
  contract.contract_version,
  pg_catalog.concat_ws('|',
    contract.metric, contract.field_path, contract.provenance,
    contract.methodology_version, contract.metric_set_id,
    contract.timeframes::text, contract.value_unit, contract.currencies::text,
    contract.required_raw_roles::text, contract.source_payload_scope,
    (EXTRACT(EPOCH FROM contract.max_freshness))::bigint::text,
    (EXTRACT(EPOCH FROM contract.max_window_end_lag))::bigint::text,
    contract.allow_derived_population::text, contract.active::text
  ) AS item
FROM arena.metric_source_contracts AS contract
JOIN arena.sources AS source_row
  ON source_row.id = contract.source_id
WHERE source_row.slug = 'binance_web3_bsc';

CREATE TEMPORARY VIEW bsc_contract_expected AS
SELECT
  seed.contract_version,
  pg_catalog.concat_ws('|',
    seed.metric, seed.field_path, seed.provenance,
    seed.methodology_version, seed.metric_set_id,
    '{7,30,90}', CASE seed.metric WHEN 'roi' THEN 'percent' ELSE 'currency' END,
    '{USD}', seed.required_raw_roles::text, seed.source_payload_scope,
    '7200', '300', 'false', 'true'
  ) AS item
FROM bsc_contract_seed AS seed;

DO $source_state$
DECLARE
  v_source arena.sources%ROWTYPE;
  v_current text[];
BEGIN
  SELECT * INTO v_source FROM arena.sources WHERE slug = 'binance_web3_bsc';
  IF NOT FOUND THEN
    RAISE NOTICE 'binance_web3_bsc is absent; nothing to register';
    RETURN;
  END IF;

  IF v_source.adapter_slug IS DISTINCT FROM 'binance_web3'
     OR v_source.currency IS DISTINCT FROM 'USD' THEN
    RAISE EXCEPTION 'binance_web3_bsc must use the binance_web3 adapter in USD (20261115160917); found % in %',
      v_source.adapter_slug, v_source.currency;
  END IF;

  SELECT pg_catalog.array_agg(DISTINCT contract.contract_version ORDER BY contract.contract_version)
    INTO v_current
    FROM arena.metric_source_contracts AS contract
   WHERE contract.source_id = v_source.id
     AND contract.active
     AND NOT EXISTS (
       SELECT 1
         FROM arena.metric_source_contract_retirements AS retirement
        WHERE retirement.source_id = contract.source_id
          AND retirement.contract_version = contract.contract_version
     );
  IF v_current IS DISTINCT FROM ARRAY['1']::text[] THEN
    RAISE EXCEPTION 'binance_web3_bsc current metric contract versions are %, expected {1}', v_current;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM arena.metric_source_contracts AS contract
     WHERE contract.source_id = v_source.id
       AND contract.contract_version <> '1'
  ) THEN
    RAISE EXCEPTION 'binance_web3_bsc already has a metric contract version other than 1';
  END IF;

  IF (SELECT pg_catalog.count(*) FROM bsc_contract_rows WHERE contract_version = '1') <> 3
     OR EXISTS (
       SELECT item FROM bsc_contract_rows WHERE contract_version = '1'
       EXCEPT
       SELECT item FROM bsc_contract_expected WHERE contract_version = '1'
     ) THEN
    RAISE EXCEPTION 'binance_web3_bsc metric contract v1 differs from the reviewed 20260721120000 rows';
  END IF;
END
$source_state$;

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
  max_window_end_lag
)
SELECT
  source_row.id,
  seed.contract_version,
  seed.metric,
  seed.field_path,
  seed.provenance,
  seed.methodology_version,
  seed.metric_set_id,
  ARRAY[7, 30, 90]::smallint[],
  CASE seed.metric WHEN 'roi' THEN 'percent' ELSE 'currency' END,
  ARRAY['USD']::text[],
  seed.required_raw_roles,
  seed.source_payload_scope,
  interval '2 hours',
  interval '5 minutes'
FROM bsc_contract_seed AS seed
JOIN arena.sources AS source_row
  ON source_row.slug = 'binance_web3_bsc'
WHERE seed.contract_version = '2'
ORDER BY seed.metric, seed.field_path;

INSERT INTO arena.metric_source_contract_retirements (
  source_id,
  contract_version,
  superseded_by_version,
  reason
)
SELECT
  source_row.id,
  '1',
  '2',
  'attempt-bound capture stores the board response verbatim; headline fields moved from board.data.data[] to data.data[]'
FROM arena.sources AS source_row
WHERE source_row.slug = 'binance_web3_bsc';

DO $postflight$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM arena.sources WHERE slug = 'binance_web3_bsc') THEN
    RETURN;
  END IF;

  IF (SELECT pg_catalog.count(*) FROM bsc_contract_rows WHERE contract_version = '2') <> 3
     OR EXISTS (
       SELECT item FROM bsc_contract_rows WHERE contract_version = '2'
       EXCEPT
       SELECT item FROM bsc_contract_expected WHERE contract_version = '2'
     ) THEN
    RAISE EXCEPTION 'binance_web3_bsc metric contract v2 rows differ from the reviewed seed';
  END IF;

  IF (SELECT pg_catalog.count(*) FROM bsc_contract_rows WHERE contract_version = '1') <> 3 THEN
    RAISE EXCEPTION 'binance_web3_bsc metric contract v1 rows must remain in place';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM arena.metric_source_contract_retirements AS retirement
      JOIN arena.sources AS source_row
        ON source_row.id = retirement.source_id
     WHERE source_row.slug = 'binance_web3_bsc'
       AND retirement.contract_version = '1'
       AND retirement.superseded_by_version = '2'
  ) THEN
    RAISE EXCEPTION 'binance_web3_bsc metric contract v1 was not retired';
  END IF;
END
$postflight$;

COMMIT;
