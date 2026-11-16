-- Migration: 20261115160917_public_source_exhaustion_and_total_capture_contracts.sql
-- Description: Register the public sources whose adapters gained
--   attempt-bound V3 capture after 20261114211034, in one reviewed step.
--
-- Every row mirrors the code registry exactly:
--   * arena.metric_source_contracts      <- lib/metric-trust.ts
--   * arena.leaderboard_exhaustion_contracts <- OKX_LEADERBOARD_EXHAUSTION
--     (lib/ingest/adapters/okx) and BINANCE_WEB3_LEADERBOARD_EXHAUSTION
--     (lib/ingest/adapters/binance-web3)
--   * arena.leaderboard_capture_contracts (manifest@3) for every source whose
--     adapter implements captureLeaderboard with a probed, binding end:
--       total mode     bitget_spot, bitget_cfd (data.maxShowSizes),
--                      toobit_futures (data.total), xt_futures (result.total),
--                      kucoin_futures (data.totalNum; capture since #477)
--       exhausted mode okx_futures, okx_spot (page_count + dataVer token),
--                      binance_web3_bsc (page_count + first-page re-read)
--
-- Source configuration the captures require (each update is guarded on the
-- seeded value; anything else is left alone and the preflight refuses it):
--   * kucoin_futures timeframes_native {7,30,90} -> {30}: the board request
--     has no window, it is 30D-anchored.
--   * okx_futures / okx_spot timeframes_native {7,30,90} -> {90}: only the 90D
--     board is natively listed; the adapter refuses 7D/30D.
--   * binance_web3_bsc currency USDT -> USD: its reviewed contract
--     (20260721120000) is USD; observations carry the source currency.
--   * toobit_futures / xt_futures page_size -> 1000: the server honours it
--     (probed 2026-11-15); at the seeded 6/10 rows a page the board moves
--     during the crawl and every capture would fail closed.
--
-- Deliberately not registered: bitget_futures (its board tail changes
-- between requests, so the reported total never binds; its metric contract is
-- registered so a run could bind if the tail ever becomes consistent),
-- xt_spot (the parser drops placeholder rows, so neither mode can hold),
-- hyperliquid, gmx, gtrade, bitfinex, bitmart_futures (no upstream end
-- signal the contract can declare), mexc_futures, phemex_futures, htx (not
-- probeable from a reachable host), btcc_futures/okx_web3_solana (already
-- registered by 20261114211034).
--
-- binance_web3_bsc keeps its v1 metric contract (20260721120000); the table
-- is append-only with no reviewed deactivation path.
--
-- POSTDEPLOY, after 20261114211034 and before 20261111192134: a registered
-- source whose deployed adapter has no capture fails every Tier-A run, so this
-- must follow the worker release that ships these captures. It requires the
-- exhaustion registry (20261115141050) and kucoin's 30D contract
-- (20261114211033). A listed source that does not exist is skipped. An
-- existing one must match its reviewed adapter, must not already be
-- registered, and must carry an active population metric contract in its own
-- currency for every native window; otherwise the whole migration refuses.
--
-- Generated only; not applied to any environment.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL search_path = pg_catalog, pg_temp;

LOCK TABLE arena.sources IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE arena.metric_source_contracts IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE arena.leaderboard_capture_contracts IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE arena.leaderboard_exhaustion_contracts IN SHARE ROW EXCLUSIVE MODE;

-- Session-local seeds (pg_temp); they disappear with the applying session.
CREATE TEMPORARY TABLE capture_source_seed (
  source_slug text PRIMARY KEY,
  adapter_slug text NOT NULL
);

INSERT INTO capture_source_seed VALUES
  ('binance_web3_bsc', 'binance_web3'),
  ('bitget_cfd', 'bitget'),
  ('bitget_spot', 'bitget'),
  ('kucoin_futures', 'kucoin'),
  ('okx_futures', 'okx'),
  ('okx_spot', 'okx'),
  ('toobit_futures', 'toobit'),
  ('xt_futures', 'xt');

CREATE TEMPORARY TABLE exhaustion_contract_seed (
  source_slug text PRIMARY KEY,
  adapter_slug text NOT NULL,
  declaration jsonb NOT NULL
);

INSERT INTO exhaustion_contract_seed VALUES
  ('binance_web3_bsc', 'binance_web3',
   '{"completeness_mode": "exhausted", "list_path": ["data", "data"], "row_key_path": ["address"], "end_signal": {"kind": "page_count", "path": ["data", "pages"]}, "board_version": {"kind": "first_page_reread"}, "max_duplicate_rows": 0}'),
  ('okx_futures', 'okx',
   '{"completeness_mode": "exhausted", "list_path": ["data", "0", "ranks"], "row_key_path": ["uniqueCode"], "end_signal": {"kind": "page_count", "path": ["data", "0", "totalPage"]}, "board_version": {"kind": "token", "path": ["data", "0", "dataVer"]}, "max_duplicate_rows": 0}'),
  ('okx_spot', 'okx',
   '{"completeness_mode": "exhausted", "list_path": ["data", "0", "ranks"], "row_key_path": ["uniqueCode"], "end_signal": {"kind": "page_count", "path": ["data", "0", "totalPage"]}, "board_version": {"kind": "token", "path": ["data", "0", "dataVer"]}, "max_duplicate_rows": 0}');

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
    ('okx_futures', 'okx', '1', 'roi', 'data[0].ranks[].pnlRatio', 'source_reported', 'okx-board-roi@1', 'okx-board-roi-pnl@1', ARRAY[90]::smallint[], 'percent', ARRAY['USDT']::text[]),
    ('okx_futures', 'okx', '1', 'pnl', 'data[0].ranks[].pnl', 'source_reported', 'okx-board-pnl@1', 'okx-board-roi-pnl@1', ARRAY[90]::smallint[], 'currency', ARRAY['USDT']::text[]),
    ('okx_spot', 'okx', '1', 'roi', 'data[0].ranks[].pnlRatio', 'source_reported', 'okx-board-roi@1', 'okx-board-roi-pnl@1', ARRAY[90]::smallint[], 'percent', ARRAY['USDT']::text[]),
    ('okx_spot', 'okx', '1', 'pnl', 'data[0].ranks[].pnl', 'source_reported', 'okx-board-pnl@1', 'okx-board-roi-pnl@1', ARRAY[90]::smallint[], 'currency', ARRAY['USDT']::text[]),
    ('bitget_futures', 'bitget', '1', 'roi', 'data.rows[].itemVoList[profit_rate].comparedValue', 'source_reported', 'bitget-board-roi@1', 'bitget-board-roi-pnl@1', ARRAY[7, 30, 90]::smallint[], 'percent', ARRAY['USDT']::text[]),
    ('bitget_futures', 'bitget', '1', 'pnl', 'data.rows[].itemVoList[total_income].comparedValue', 'source_reported', 'bitget-board-pnl@1', 'bitget-board-roi-pnl@1', ARRAY[7, 30, 90]::smallint[], 'currency', ARRAY['USDT']::text[]),
    ('bitget_spot', 'bitget', '1', 'roi', 'data.rows[].itemVoList[profit_rate].comparedValue', 'source_reported', 'bitget-board-roi@1', 'bitget-board-roi-pnl@1', ARRAY[7, 30, 90]::smallint[], 'percent', ARRAY['USDT']::text[]),
    ('bitget_cfd', 'bitget', '1', 'roi', 'data.rows[].itemVoList[profit_rate].comparedValue', 'source_reported', 'bitget-board-roi@1', 'bitget-board-roi-pnl@1', ARRAY[7, 30, 90]::smallint[], 'percent', ARRAY['USDT']::text[]),
    ('toobit_futures', 'toobit', '1', 'roi', 'data.list[].leaderAvgProfitRatio', 'source_reported', 'toobit-board-roi@1', 'toobit-board-roi-pnl@1', ARRAY[7, 30, 90]::smallint[], 'percent', ARRAY['USDT']::text[]),
    ('toobit_futures', 'toobit', '1', 'pnl', 'data.list[].pnl', 'source_reported', 'toobit-board-pnl@1', 'toobit-board-roi-pnl@1', ARRAY[7, 30, 90]::smallint[], 'currency', ARRAY['USDT']::text[]),
    ('xt_futures', 'xt', '1', 'roi', 'result.items[].incomeRate', 'source_reported', 'xt-board-roi@1', 'xt-board-roi-pnl@1', ARRAY[7, 30, 90]::smallint[], 'percent', ARRAY['USDT']::text[]),
    ('xt_futures', 'xt', '1', 'pnl', 'result.items[].income', 'source_reported', 'xt-board-pnl@1', 'xt-board-roi-pnl@1', ARRAY[7, 30, 90]::smallint[], 'currency', ARRAY['USDT']::text[]);

DO $preflight$
DECLARE
  v_bad text;
BEGIN
  IF pg_catalog.to_regclass('arena.sources') IS NULL
     OR pg_catalog.to_regclass('arena.metric_source_contracts') IS NULL
     OR pg_catalog.to_regclass('arena.leaderboard_capture_contracts') IS NULL
     OR pg_catalog.to_regclass('arena.leaderboard_exhaustion_contracts') IS NULL
     OR pg_catalog.to_regprocedure(
       'arena.leaderboard_exhaustion_declaration_valid(jsonb)'
     ) IS NULL THEN
    RAISE EXCEPTION 'public source capture registration requires the capture, metric-contract and exhaustion registries (20261115141050)';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_constraint AS constraint_row
     WHERE constraint_row.conrelid = 'arena.leaderboard_capture_contracts'::pg_catalog.regclass
       AND constraint_row.conname = 'leaderboard_capture_contracts_capture_contract_check'
       AND pg_catalog.strpos(
             pg_catalog.pg_get_constraintdef(constraint_row.oid),
             'arena.ingest.leaderboard-acquisition-manifest@3'
           ) > 0
  ) THEN
    RAISE EXCEPTION 'capture registry does not admit manifest V3';
  END IF;

  SELECT pg_catalog.string_agg(DISTINCT source_row.slug, ', ' ORDER BY source_row.slug)
    INTO v_bad
    FROM (
      SELECT seed.source_slug, seed.adapter_slug FROM capture_source_seed AS seed
      UNION ALL
      SELECT seed.source_slug, seed.adapter_slug FROM board_metric_contract_seed AS seed
      UNION ALL
      SELECT seed.source_slug, seed.adapter_slug FROM exhaustion_contract_seed AS seed
    ) AS seed
    JOIN arena.sources AS source_row
      ON source_row.slug = seed.source_slug
   WHERE source_row.adapter_slug IS DISTINCT FROM seed.adapter_slug;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'public source capture adapter drift: %', v_bad;
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

  SELECT pg_catalog.string_agg(source_row.slug, ', ' ORDER BY source_row.slug)
    INTO v_bad
    FROM capture_source_seed AS seed
    JOIN arena.sources AS source_row
      ON source_row.slug = seed.source_slug
    JOIN arena.leaderboard_capture_contracts AS capture
      ON capture.source_id = source_row.id
     AND capture.capture_contract = 'arena.ingest.leaderboard-acquisition-manifest@3';
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'attempt-bound V3 capture already registered for: %', v_bad;
  END IF;

  SELECT pg_catalog.string_agg(source_row.slug, ', ' ORDER BY source_row.slug)
    INTO v_bad
    FROM exhaustion_contract_seed AS seed
    JOIN arena.sources AS source_row
      ON source_row.slug = seed.source_slug
    JOIN arena.leaderboard_exhaustion_contracts AS contract
      ON contract.source_id = source_row.id;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'leaderboard exhaustion contract already registered for: %', v_bad;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM exhaustion_contract_seed AS seed
     WHERE NOT arena.leaderboard_exhaustion_declaration_valid(seed.declaration)
        OR seed.source_slug NOT IN (SELECT capture.source_slug FROM capture_source_seed AS capture)
  ) THEN
    RAISE EXCEPTION 'exhaustion contract seed is malformed';
  END IF;
END
$preflight$;

-- Source configuration the reviewed captures require (seeded values only).
UPDATE arena.sources
   SET timeframes_native = '{30}'
 WHERE slug = 'kucoin_futures'
   AND adapter_slug = 'kucoin'
   AND timeframes_native = '{7,30,90}';

UPDATE arena.sources
   SET timeframes_native = '{90}'
 WHERE slug IN ('okx_futures', 'okx_spot')
   AND adapter_slug = 'okx'
   AND timeframes_native = '{7,30,90}';

UPDATE arena.sources
   SET currency = 'USD'
 WHERE slug = 'binance_web3_bsc'
   AND adapter_slug = 'binance_web3'
   AND currency = 'USDT';

UPDATE arena.sources
   SET page_size = 1000
 WHERE slug IN ('toobit_futures', 'xt_futures')
   AND adapter_slug IN ('toobit', 'xt')
   AND page_size IS DISTINCT FROM 1000;

DO $currency$
DECLARE
  v_bad text;
BEGIN
  SELECT pg_catalog.string_agg(DISTINCT source_row.slug, ', ' ORDER BY source_row.slug)
    INTO v_bad
    FROM board_metric_contract_seed AS seed
    JOIN arena.sources AS source_row
      ON source_row.slug = seed.source_slug
   WHERE NOT (source_row.currency = ANY (seed.currencies));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'board metric source contract currency drift: %', v_bad;
  END IF;
END
$currency$;

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

-- Tier-A refuses an attempt-bound V3 window without a reviewed population
-- contract in the source's currency, so every native window must be covered.
DO $windows$
DECLARE
  v_bad text;
BEGIN
  SELECT pg_catalog.string_agg(
           source_row.slug || ':' || window_days::text || 'd',
           ', ' ORDER BY source_row.slug, window_days
         )
    INTO v_bad
    FROM capture_source_seed AS seed
    JOIN arena.sources AS source_row
      ON source_row.slug = seed.source_slug
    CROSS JOIN LATERAL pg_catalog.unnest(source_row.timeframes_native) AS window_days
   WHERE NOT EXISTS (
     SELECT 1
       FROM arena.metric_source_contracts AS contract
      WHERE contract.source_id = source_row.id
        AND contract.active
        AND contract.source_payload_scope = 'population_snapshot'
        AND window_days::smallint = ANY (contract.timeframes)
        AND source_row.currency = ANY (contract.currencies)
   );
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'attempt-bound capture needs a population metric contract for: %', v_bad;
  END IF;
END
$windows$;

INSERT INTO arena.leaderboard_exhaustion_contracts (
  source_id,
  completeness_contract,
  declaration
)
SELECT
  source_row.id,
  'arena.ingest.leaderboard-exhaustion-completeness@1',
  seed.declaration
FROM exhaustion_contract_seed AS seed
JOIN arena.sources AS source_row
  ON source_row.slug = seed.source_slug
 AND source_row.adapter_slug = seed.adapter_slug
ORDER BY source_row.slug;

INSERT INTO arena.leaderboard_capture_contracts (
  source_id,
  capture_contract,
  adapter_slug,
  attempt_binding_contract,
  requires_runner_git_sha
)
SELECT
  source_row.id,
  'arena.ingest.leaderboard-acquisition-manifest@3',
  source_row.adapter_slug,
  'arena.ingest.leaderboard-acquisition-attempt-binding@1',
  true
FROM capture_source_seed AS seed
JOIN arena.sources AS source_row
  ON source_row.slug = seed.source_slug
 AND source_row.adapter_slug = seed.adapter_slug
ORDER BY source_row.slug;

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
     )
     OR (
       SELECT pg_catalog.count(*)
         FROM arena.leaderboard_exhaustion_contracts AS contract
         JOIN arena.sources AS source_row
           ON source_row.id = contract.source_id
         JOIN exhaustion_contract_seed AS seed
           ON seed.source_slug = source_row.slug
          AND seed.declaration = contract.declaration
     ) <> (
       SELECT pg_catalog.count(*)
         FROM exhaustion_contract_seed AS seed
         JOIN arena.sources AS source_row
           ON source_row.slug = seed.source_slug
     )
     OR (
       SELECT pg_catalog.count(*)
         FROM arena.leaderboard_capture_contracts AS capture
         JOIN arena.sources AS source_row
           ON source_row.id = capture.source_id
         JOIN capture_source_seed AS seed
           ON seed.source_slug = source_row.slug
        WHERE capture.capture_contract = 'arena.ingest.leaderboard-acquisition-manifest@3'
          AND capture.adapter_slug = seed.adapter_slug
          AND capture.attempt_binding_contract =
              'arena.ingest.leaderboard-acquisition-attempt-binding@1'
          AND capture.requires_runner_git_sha
     ) <> (
       SELECT pg_catalog.count(*)
         FROM capture_source_seed AS seed
         JOIN arena.sources AS source_row
           ON source_row.slug = seed.source_slug
     ) THEN
    RAISE EXCEPTION 'public source capture registration postflight failed';
  END IF;
END
$postflight$;

COMMIT;
