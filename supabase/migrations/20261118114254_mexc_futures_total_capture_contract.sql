-- Migration: 20261118114254_mexc_futures_total_capture_contract.sql
-- Description: Register attempt-bound V3 capture for mexc_futures, in the
--   same shape 20261115160917 used for the other total-mode public boards.
--
-- Every row mirrors the code registry exactly:
--   * arena.metric_source_contracts      <- lib/metric-trust.ts mexc_futures
--     (data.content[].roi percent, data.content[].pnl USDT; 7D only)
--   * arena.leaderboard_capture_contracts (manifest@3) <- the mexc adapter's
--     captureLeaderboard: GET traders/v2 in reported-total mode, bound by
--     data.total (no exhaustion contract).
--
-- Live probe 2026-11-18 (headless page, same-origin fetch): limit=100 page 1
-- reports data.total=7100, page 71 serves orders 7001-7100, page 72 is empty
-- and still reports 7100; any limit above 100 answers code 600.
--
-- Source configuration the capture requires (guarded on the adapter; any
-- other value is left alone and the preflight/windows check refuses it):
--   * page_size -> 100: the upstream maximum. At the seeded 30 rows a page the
--     7100-row board needs 237 requests and moves during the crawl.
--   * timeframes_native must already be {7}: the board request carries no
--     window and the adapter refuses 7D-less captures; 30D/90D stay derived.
--
-- POSTDEPLOY, after 20261115160917 and before 20261111192134: a registered
-- source whose deployed adapter has no capture fails every Tier-A run, so this
-- must follow the worker release that ships the mexc capture. If mexc_futures
-- does not exist the migration changes nothing. An existing row must use the
-- mexc adapter, must not already be registered, and must end up with an active
-- population metric contract in its own currency for every native window;
-- otherwise the whole migration refuses.
--
-- Generated only; not applied to any environment.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL search_path = pg_catalog, pg_temp;

LOCK TABLE arena.sources IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE arena.metric_source_contracts IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE arena.leaderboard_capture_contracts IN SHARE ROW EXCLUSIVE MODE;

-- Session-local seeds (pg_temp); they disappear with the applying session.
CREATE TEMPORARY TABLE capture_source_seed (
  source_slug text PRIMARY KEY,
  adapter_slug text NOT NULL
);

INSERT INTO capture_source_seed VALUES
  ('mexc_futures', 'mexc');

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
    ('mexc_futures', 'mexc', '1', 'roi', 'data.content[].roi', 'source_reported', 'mexc-board-roi@1', 'mexc-board-roi-pnl@1', ARRAY[7]::smallint[], 'percent', ARRAY['USDT']::text[]),
    ('mexc_futures', 'mexc', '1', 'pnl', 'data.content[].pnl', 'source_reported', 'mexc-board-pnl@1', 'mexc-board-roi-pnl@1', ARRAY[7]::smallint[], 'currency', ARRAY['USDT']::text[]);

DO $preflight$
DECLARE
  v_bad text;
BEGIN
  IF pg_catalog.to_regclass('arena.sources') IS NULL
     OR pg_catalog.to_regclass('arena.metric_source_contracts') IS NULL
     OR pg_catalog.to_regclass('arena.leaderboard_capture_contracts') IS NULL THEN
    RAISE EXCEPTION 'mexc_futures capture registration requires the capture and metric-contract registries';
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
    ) AS seed
    JOIN arena.sources AS source_row
      ON source_row.slug = seed.source_slug
   WHERE source_row.adapter_slug IS DISTINCT FROM seed.adapter_slug;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'mexc_futures capture adapter drift: %', v_bad;
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
END
$preflight$;

-- Source configuration the reviewed capture requires.
UPDATE arena.sources
   SET page_size = 100
 WHERE slug = 'mexc_futures'
   AND adapter_slug = 'mexc'
   AND page_size IS DISTINCT FROM 100;

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
-- contract in the source's currency, so every native window must be covered
-- (a mexc_futures row with any native window other than 7D refuses here).
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
     )
     OR EXISTS (
       SELECT 1
         FROM arena.sources AS source_row
        WHERE source_row.slug = 'mexc_futures'
          AND source_row.page_size IS DISTINCT FROM 100
     ) THEN
    RAISE EXCEPTION 'mexc_futures capture registration postflight failed';
  END IF;
END
$postflight$;

COMMIT;
