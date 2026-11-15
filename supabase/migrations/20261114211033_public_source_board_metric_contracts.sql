-- Register the reviewed board-headline metric source contracts for the public
-- Tier-A sources that gained attempt-bound capture (lib/ingest/fetch/
-- replay-capture.ts). The rows mirror lib/metric-trust.ts exactly: the worker's
-- trusted V3 publisher refuses any code/database drift, and Tier-A refuses an
-- attempt-bound V3 window that has no reviewed population contract.
--
-- Provenance only: these rows are not window, population or rank authority.
-- Rerank, the public ranked leaderboard and the freshness gate do not read
-- them. Population authority comes from each capture's own manifest.
--
-- PREDEPLOY. The deployed worker never reads metric contracts for a source it
-- cannot capture, so the rows are inert until the new worker ships. The
-- capture registration (20261114211034) is POSTDEPLOY and requires these rows.
--
-- A listed source that does not exist is skipped (the 2026-10-30 backup does
-- not carry every seed row); an existing one must match its reviewed adapter
-- and currency, and must not already carry an active contract.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL search_path = pg_catalog, pg_temp;

LOCK TABLE arena.sources IN SHARE MODE;
LOCK TABLE arena.metric_source_contracts IN SHARE ROW EXCLUSIVE MODE;

-- Session-local seed (pg_temp); it disappears with the applying session.
CREATE TEMPORARY TABLE board_metric_contract_seed (
  source_slug text NOT NULL,
  adapter_slug text NOT NULL,
  contract_version text NOT NULL,
  metric text NOT NULL,
  field_path text NOT NULL,
  provenance text NOT NULL,
  methodology_version text NOT NULL,
  metric_set_id text NOT NULL,
  timeframes smallint[] NOT NULL,
  value_unit text NOT NULL,
  currencies text[] NOT NULL
);

INSERT INTO board_metric_contract_seed VALUES
    ('coinex_futures', 'coinex', '1', 'roi', 'data.data[].profit_rate', 'source_reported', 'coinex-board-roi@1', 'coinex-board-roi-pnl@1', ARRAY[7, 30, 90]::smallint[], 'percent', ARRAY['USDT']::text[]),
    ('coinex_futures', 'coinex', '1', 'pnl', 'data.data[].profit_amount', 'source_reported', 'coinex-board-pnl@1', 'coinex-board-roi-pnl@1', ARRAY[7, 30, 90]::smallint[], 'currency', ARRAY['USDT']::text[]),
    ('htx_futures', 'htx', '1', 'roi', 'data.itemList[].profitRate90', 'source_reported', 'htx-board-roi@1', 'htx-board-roi-pnl@1', ARRAY[90]::smallint[], 'percent', ARRAY['USDT']::text[]),
    ('htx_futures', 'htx', '1', 'pnl', 'data.itemList[].profit90', 'source_reported', 'htx-board-pnl@1', 'htx-board-roi-pnl@1', ARRAY[90]::smallint[], 'currency', ARRAY['USDT']::text[]),
    ('htx_spot', 'htx', '1', 'roi', 'data.itemList[].profitRate90', 'source_reported', 'htx-board-roi@1', 'htx-board-roi-pnl@1', ARRAY[90]::smallint[], 'percent', ARRAY['USDT']::text[]),
    ('htx_spot', 'htx', '1', 'pnl', 'data.itemList[].profit90', 'source_reported', 'htx-board-pnl@1', 'htx-board-roi-pnl@1', ARRAY[90]::smallint[], 'currency', ARRAY['USDT']::text[]),
    ('kucoin_futures', 'kucoin', '1', 'roi', 'data.items[].thirtyDayPnlRatio', 'source_normalized', 'kucoin-board-roi@1', 'kucoin-board-roi-pnl@1', ARRAY[30]::smallint[], 'percent', ARRAY['USDT']::text[]),
    ('kucoin_futures', 'kucoin', '1', 'pnl', 'data.items[].thirtyDayPnl', 'source_reported', 'kucoin-board-pnl@1', 'kucoin-board-roi-pnl@1', ARRAY[30]::smallint[], 'currency', ARRAY['USDT']::text[]),
    ('bybit_copytrade', 'bybit_copytrade', '1', 'roi', 'result.leaderDetails[].metricValues[roi]', 'source_reported', 'bybit-copytrade-board-roi@1', 'bybit-copytrade-board-roi-pnl@1', ARRAY[7, 30, 90]::smallint[], 'percent', ARRAY['USDT']::text[]),
    ('bybit_mt5', 'bybit_mt5', '1', 'roi', 'result.providerDetailsList[].roeE4', 'source_reported', 'bybit-mt5-board-roi@1', 'bybit-mt5-board-roi-pnl@1', ARRAY[7, 30, 90]::smallint[], 'percent', ARRAY['USDx']::text[]),
    ('bybit_mt5', 'bybit_mt5', '1', 'pnl', 'result.providerDetailsList[].masterPnlE8', 'source_reported', 'bybit-mt5-board-pnl@1', 'bybit-mt5-board-roi-pnl@1', ARRAY[7, 30, 90]::smallint[], 'currency', ARRAY['USDx']::text[]),
    ('gate_futures', 'gate', '1', 'roi', 'data.list[].profit_rate', 'source_reported', 'gate-board-roi@1', 'gate-board-roi-pnl@1', ARRAY[7, 30, 90]::smallint[], 'percent', ARRAY['USDT']::text[]),
    ('gate_futures', 'gate', '1', 'pnl', 'data.list[].profit', 'source_reported', 'gate-board-pnl@1', 'gate-board-roi-pnl@1', ARRAY[7, 30, 90]::smallint[], 'currency', ARRAY['USDT']::text[]),
    ('gate_cfd', 'gate', '1', 'roi', 'data.lists[].profit_rate', 'source_reported', 'gate-board-roi@1', 'gate-board-roi-pnl@1', ARRAY[7, 30, 90]::smallint[], 'percent', ARRAY['USDx']::text[]),
    ('gate_cfd', 'gate', '1', 'pnl', 'data.lists[].profit', 'source_reported', 'gate-board-pnl@1', 'gate-board-roi-pnl@1', ARRAY[7, 30, 90]::smallint[], 'currency', ARRAY['USDx']::text[]),
    ('blofin_futures', 'blofin', '1', 'roi', 'data.trader_info[].roi', 'source_reported', 'blofin-board-roi@1', 'blofin-board-roi-pnl@1', ARRAY[7, 30, 90]::smallint[], 'percent', ARRAY['USDT']::text[]),
    ('blofin_futures', 'blofin', '1', 'pnl', 'data.trader_info[].pnl', 'source_reported', 'blofin-board-pnl@1', 'blofin-board-roi-pnl@1', ARRAY[7, 30, 90]::smallint[], 'currency', ARRAY['USDT']::text[]),
    ('blofin_spot', 'blofin', '1', 'roi', 'data.trader_info[].roi', 'source_reported', 'blofin-board-roi@1', 'blofin-board-roi-pnl@1', ARRAY[7, 30, 90]::smallint[], 'percent', ARRAY['USDT']::text[]),
    ('blofin_spot', 'blofin', '1', 'pnl', 'data.trader_info[].pnl', 'source_reported', 'blofin-board-pnl@1', 'blofin-board-roi-pnl@1', ARRAY[7, 30, 90]::smallint[], 'currency', ARRAY['USDT']::text[]),
    ('btcc_futures', 'btcc', '1', 'roi', 'rows[].rateProfit', 'source_reported', 'btcc-board-roi@1', 'btcc-board-roi-pnl@1', ARRAY[30]::smallint[], 'percent', ARRAY['USDT']::text[]),
    ('btcc_futures', 'btcc', '1', 'pnl', 'rows[].totalNetProfit', 'source_reported', 'btcc-board-pnl@1', 'btcc-board-roi-pnl@1', ARRAY[30]::smallint[], 'currency', ARRAY['USDT']::text[]),
    ('bitunix_futures', 'bitunix', '1', 'roi', 'data.records[].roi', 'source_reported', 'bitunix-board-roi@1', 'bitunix-board-roi-pnl@1', ARRAY[7, 30, 90]::smallint[], 'percent', ARRAY['USDT']::text[]),
    ('bitunix_futures', 'bitunix', '1', 'pnl', 'data.records[].pl', 'source_reported', 'bitunix-board-pnl@1', 'bitunix-board-roi-pnl@1', ARRAY[7, 30, 90]::smallint[], 'currency', ARRAY['USDT']::text[]),
    ('lbank_futures', 'lbank', '1', 'roi', 'data.records[].sprofitRate', 'source_reported', 'lbank-board-roi@1', 'lbank-board-roi-pnl@1', ARRAY[7, 30]::smallint[], 'percent', ARRAY['USDT']::text[]),
    ('lbank_futures', 'lbank', '1', 'pnl', 'data.records[].sprofit', 'source_reported', 'lbank-board-pnl@1', 'lbank-board-roi-pnl@1', ARRAY[7, 30]::smallint[], 'currency', ARRAY['USDT']::text[]),
    ('okx_web3_solana', 'okx_web3', '1', 'roi', 'data.rankingInfos[].roi', 'source_reported', 'okx-web3-board-roi@1', 'okx-web3-board-roi-pnl@1', ARRAY[7, 30, 90]::smallint[], 'percent', ARRAY['USDC']::text[]),
    ('okx_web3_solana', 'okx_web3', '1', 'pnl', 'data.rankingInfos[].pnl', 'source_reported', 'okx-web3-board-pnl@1', 'okx-web3-board-roi-pnl@1', ARRAY[7, 30, 90]::smallint[], 'currency', ARRAY['USDC']::text[]);

DO $preflight$
DECLARE
  v_bad text;
BEGIN
  IF pg_catalog.to_regclass('arena.sources') IS NULL
     OR pg_catalog.to_regclass('arena.metric_source_contracts') IS NULL THEN
    RAISE EXCEPTION 'board metric source contracts require arena.sources and metric_source_contracts';
  END IF;

  SELECT pg_catalog.string_agg(DISTINCT source_row.slug, ', ' ORDER BY source_row.slug)
    INTO v_bad
    FROM board_metric_contract_seed AS seed
    JOIN arena.sources AS source_row
      ON source_row.slug = seed.source_slug
   WHERE source_row.adapter_slug IS DISTINCT FROM seed.adapter_slug
      OR NOT (source_row.currency = ANY (seed.currencies));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'board metric source contract adapter/currency drift: %', v_bad;
  END IF;

  SELECT pg_catalog.string_agg(DISTINCT source_row.slug, ', ' ORDER BY source_row.slug)
    INTO v_bad
    FROM arena.metric_source_contracts AS contract
    JOIN arena.sources AS source_row
      ON source_row.id = contract.source_id
   WHERE contract.active
     AND source_row.slug IN (SELECT seed.source_slug FROM board_metric_contract_seed AS seed);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'board metric source contracts already registered for: %', v_bad;
  END IF;
END
$preflight$;

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
  seed.timeframes,
  seed.value_unit,
  seed.currencies,
  ARRAY['source_payload', 'population_manifest']::text[],
  'population_snapshot',
  interval '6 hours',
  interval '5 minutes'
FROM board_metric_contract_seed AS seed
JOIN arena.sources AS source_row
  ON source_row.slug = seed.source_slug
 AND source_row.adapter_slug = seed.adapter_slug
ORDER BY seed.source_slug, seed.metric;

DO $postflight$
BEGIN
  IF (
       SELECT pg_catalog.count(*)
         FROM arena.metric_source_contracts AS contract
         JOIN arena.sources AS source_row
           ON source_row.id = contract.source_id
         JOIN board_metric_contract_seed AS seed
           ON seed.source_slug = source_row.slug
          AND seed.metric = contract.metric
          AND seed.field_path = contract.field_path
          AND seed.methodology_version = contract.methodology_version
        WHERE contract.active
     ) <> (
       SELECT pg_catalog.count(*)
         FROM board_metric_contract_seed AS seed
         JOIN arena.sources AS source_row
           ON source_row.slug = seed.source_slug
     ) THEN
    RAISE EXCEPTION 'board metric source contract registration postflight failed';
  END IF;
END
$postflight$;

COMMIT;
