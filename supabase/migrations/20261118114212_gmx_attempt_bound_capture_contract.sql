-- Migration: 20261118114212_gmx_attempt_bound_capture_contract.sql
-- Description: Register attempt-bound V3 capture for `gmx`, whose adapter now
--   implements captureLeaderboard (exhausted mode, one verbatim response).
--
-- Every row mirrors the code registry exactly:
--   * arena.metric_source_contracts          <- lib/metric-trust.ts `gmx`
--   * arena.leaderboard_exhaustion_contracts <- GMX_LEADERBOARD_EXHAUSTION
--     (lib/ingest/adapters/gmx): short_page end + first-page re-read
--   * arena.leaderboard_capture_contracts (manifest@3)
--
-- Why GMX can now bind (20261115160917 left it out for want of an end
-- signal): periodAccountStats answers the whole completed-UTC-day window in
-- one unsorted response (live 2026-11-18: 2,516 / 3,274 / 4,920 accounts for
-- 7d/30d/90d). The capture requests it with limit = page_size = 50000, so a
-- response shorter than the limit is the population end (short_page), and
-- re-reads it once to prove the board did not move. The board is no longer
-- truncated to meta.board_depth: the full population is published and the
-- parser orders it by realized-net PnL.
--
-- Source configuration the capture requires (guarded on the seeded value;
-- anything else is left alone and the preflight refuses it):
--   * gmx page_size 20 -> 50000: the short-page proof compares each response
--     with the source's page_size, and the adapter refuses any other value.
--   * gmx expected_count 60 -> NULL: 60 was the truncated-board survey count.
--     The full population (2.5k-4.9k per window) would fail the ±30% day-one
--     count gate against it; NULL lets the rolling baseline of real passing
--     crawls govern (as okx_web3_solana). Production read-only 2026-11-18:
--     page_size 20, expected_count 60, no gmx metric contract rows.
--
-- Metric provenance is source_normalized (the population publisher refuses
-- self-certified provenance): both values are normalized from the row's own
-- 1e30 fixed-point components under the GMX realized-net contract, so the
-- source meta must already declare it: pnl_contract_version = 2,
-- pnl_basis_board = gmx_period_realized_net, roi_basis_board =
-- max_capital_usd. This migration registers the metric contracts itself.
--
-- POSTDEPLOY, after 20261115160917 and before 20261111192134: registered
-- before the worker release that ships the gmx capture, every Tier-A run of
-- gmx would fail. It requires the capture, metric-contract and exhaustion
-- registries (20261115141050). An absent gmx row is skipped. An existing one
-- must use adapter gmx, currency USDC, that realized-net contract, and must
-- not already be registered; otherwise the whole migration refuses.
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
  adapter_slug text NOT NULL,
  page_size integer NOT NULL
);

INSERT INTO capture_source_seed VALUES
  ('gmx', 'gmx', 50000);

CREATE TEMPORARY TABLE exhaustion_contract_seed (
  source_slug text PRIMARY KEY,
  adapter_slug text NOT NULL,
  declaration jsonb NOT NULL
);

INSERT INTO exhaustion_contract_seed VALUES
  ('gmx', 'gmx',
   '{"completeness_mode": "exhausted", "list_path": ["data", "periodAccountStats"], "row_key_path": ["id"], "end_signal": {"kind": "short_page"}, "board_version": {"kind": "first_page_reread"}, "max_duplicate_rows": 0}');

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
    ('gmx', 'gmx', '1', 'roi', 'data.periodAccountStats[].realizedPnl/maxCapital', 'source_normalized', 'gmx-board-roi@1', 'gmx-board-roi-pnl@1', ARRAY[7, 30, 90]::smallint[], 'percent', ARRAY['USDC']::text[]),
    ('gmx', 'gmx', '1', 'pnl', 'data.periodAccountStats[].realizedPnl', 'source_normalized', 'gmx-board-pnl@1', 'gmx-board-roi-pnl@1', ARRAY[7, 30, 90]::smallint[], 'currency', ARRAY['USDC']::text[]);

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
    RAISE EXCEPTION 'gmx capture registration requires the capture, metric-contract and exhaustion registries (20261115141050)';
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
    RAISE EXCEPTION 'gmx capture adapter drift: %', v_bad;
  END IF;

  -- The registered methodology is the realized-net board contract the
  -- source meta declares (keys present in production, 2026-11-18).
  SELECT pg_catalog.string_agg(source_row.slug, ', ' ORDER BY source_row.slug)
    INTO v_bad
    FROM capture_source_seed AS seed
    JOIN arena.sources AS source_row
      ON source_row.slug = seed.source_slug
   WHERE source_row.meta->>'pnl_basis_board' IS DISTINCT FROM 'gmx_period_realized_net'
      OR source_row.meta->>'roi_basis_board' IS DISTINCT FROM 'max_capital_usd'
      OR source_row.meta->>'pnl_contract_version' IS DISTINCT FROM '2';
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'gmx capture requires the realized-net source contract (pnl_contract_version 2): %', v_bad;
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

-- Source configuration the reviewed capture requires (seeded value only).
UPDATE arena.sources AS source_row
   SET page_size = seed.page_size
  FROM capture_source_seed AS seed
 WHERE source_row.slug = seed.source_slug
   AND source_row.adapter_slug = seed.adapter_slug
   AND source_row.page_size = 20;

UPDATE arena.sources AS source_row
   SET expected_count = NULL
  FROM capture_source_seed AS seed
 WHERE source_row.slug = seed.source_slug
   AND source_row.adapter_slug = seed.adapter_slug
   AND source_row.expected_count = 60;

DO $configuration$
DECLARE
  v_bad text;
BEGIN
  SELECT pg_catalog.string_agg(DISTINCT source_row.slug, ', ' ORDER BY source_row.slug)
    INTO v_bad
    FROM capture_source_seed AS seed
    JOIN arena.sources AS source_row
      ON source_row.slug = seed.source_slug
   WHERE source_row.page_size IS DISTINCT FROM seed.page_size;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'gmx capture page_size drift: %', v_bad;
  END IF;

  SELECT pg_catalog.string_agg(DISTINCT source_row.slug, ', ' ORDER BY source_row.slug)
    INTO v_bad
    FROM capture_source_seed AS seed
    JOIN arena.sources AS source_row
      ON source_row.slug = seed.source_slug
   WHERE source_row.expected_count IS NOT NULL;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'gmx capture expected_count drift: %', v_bad;
  END IF;

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
$configuration$;

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
    RAISE EXCEPTION 'gmx capture registration postflight failed';
  END IF;
END
$postflight$;

COMMIT;
