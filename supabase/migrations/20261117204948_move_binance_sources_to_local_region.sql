-- Migration: 20261117204948_move_binance_sources_to_local_region.sql
-- Description: Owner decision (2026-11-17): the `local` ingest region fetches
--   binance_futures and binance_spot. Only fetch_region changes
--   (vps_sg -> local); status, serving_mode, timeframes, page size and every
--   contract stay as they are.
--
-- Why: the SG node is not running, so both sources were stale and the public
--   leaderboard would publish without Binance. The seed pinned them to vps_sg
--   on the assumption that Binance is blocked from the local host. A read-only
--   probe from the local Mac on 2026-11-18 (real Chromium, the adapter's own
--   warm-up: /en/copy-trading then robots.txt, same-origin in-page fetch)
--   answered code 000000 on:
--     futures home-page/query-list            7D/30D/90D  total 13127 (and page 50)
--     spot    common/home-page-list           7D/30D/90D  total 2469
--     futures lead-portfolio/detail, chart-data; spot lead-portfolio/detail
--   so the SG exit is not needed. Same reasoning as 20261116204359 (okx,
--   toobit). bitmart_futures stays on vps_sg: www.bitmart.com serves an
--   interactive Turnstile to the local host (curl 403 on 2026-11-18).
--
-- The scheduler routes a source to the queue of its fetch_region, and the
-- adapter opens its session by src.fetch_region, so no worker code changes.
--
-- POSTDEPLOY, after 20261117015119: both sources are already active/serving
-- with their V3 capture contract and profile capture contract registered; a
-- local worker release must be running to consume the local queue. It touches
-- no table 20261111192134 guards.
--
-- A missing row, any other pre-state (including a replay), a missing V3
-- capture contract, or a native window without an active population metric
-- contract refuses the whole migration.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL search_path = pg_catalog, pg_temp;

LOCK TABLE arena.sources IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE arena.metric_source_contracts IN SHARE MODE;
LOCK TABLE arena.leaderboard_capture_contracts IN SHARE MODE;

DO $preflight$
DECLARE
  v_bad text;
BEGIN
  IF pg_catalog.to_regclass('arena.sources') IS NULL
     OR pg_catalog.to_regclass('arena.metric_source_contracts') IS NULL
     OR pg_catalog.to_regclass('arena.leaderboard_capture_contracts') IS NULL THEN
    RAISE EXCEPTION 'binance local region move requires the source, capture and metric-contract registries';
  END IF;

  SELECT pg_catalog.string_agg(slug_row.slug, ', ' ORDER BY slug_row.slug)
    INTO v_bad
    FROM (VALUES ('binance_futures'::text), ('binance_spot')) AS slug_row(slug)
   WHERE NOT EXISTS (
     SELECT 1
       FROM (
         VALUES
           ('binance_futures'::text, 'futures'::text),
           ('binance_spot', 'spot')
       ) AS expected(slug, product_type)
       JOIN arena.sources AS source_row
         ON source_row.slug = expected.slug
        AND source_row.adapter_slug = 'binance'
        AND source_row.product_type = expected.product_type
        AND source_row.status = 'active'
        AND source_row.serving_mode = 'serving'
        AND source_row.fetch_region = 'vps_sg'
        AND source_row.currency = 'USDT'
        AND source_row.timeframes_native = ARRAY[7, 30, 90]::integer[]
        AND source_row.timeframes_derived = ARRAY[]::integer[]
        AND source_row.page_size IS NOT DISTINCT FROM 20
        AND source_row.meta->>'boardKey' = expected.product_type
      WHERE expected.slug = slug_row.slug
   );
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'binance local region move pre-state drift: %', v_bad;
  END IF;

  SELECT pg_catalog.string_agg(source_row.slug, ', ' ORDER BY source_row.slug)
    INTO v_bad
    FROM arena.sources AS source_row
   WHERE source_row.slug IN ('binance_futures', 'binance_spot')
     AND NOT EXISTS (
       SELECT 1
         FROM arena.leaderboard_capture_contracts AS capture
        WHERE capture.source_id = source_row.id
          AND capture.capture_contract = 'arena.ingest.leaderboard-acquisition-manifest@3'
          AND capture.adapter_slug = source_row.adapter_slug
          AND capture.attempt_binding_contract =
              'arena.ingest.leaderboard-acquisition-attempt-binding@1'
          AND capture.requires_runner_git_sha
     );
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'binance local region move requires the V3 capture contract for: %', v_bad;
  END IF;

  SELECT pg_catalog.string_agg(
           source_row.slug || ':' || window_days::text || 'd',
           ', ' ORDER BY source_row.slug, window_days
         )
    INTO v_bad
    FROM arena.sources AS source_row
    CROSS JOIN LATERAL pg_catalog.unnest(source_row.timeframes_native) AS window_days
   WHERE source_row.slug IN ('binance_futures', 'binance_spot')
     AND NOT EXISTS (
       SELECT 1
         FROM arena.metric_source_contracts AS contract
        WHERE contract.source_id = source_row.id
          AND contract.active
          AND contract.source_payload_scope = 'population_snapshot'
          AND window_days::smallint = ANY (contract.timeframes)
          AND source_row.currency = ANY (contract.currencies)
     );
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'binance local region move needs a population metric contract for: %', v_bad;
  END IF;
END
$preflight$;

UPDATE arena.sources
   SET fetch_region = 'local'
 WHERE slug IN ('binance_futures', 'binance_spot')
   AND fetch_region = 'vps_sg';

DO $postflight$
BEGIN
  IF (
    SELECT pg_catalog.count(*)
      FROM arena.sources AS source_row
     WHERE source_row.slug IN ('binance_futures', 'binance_spot')
       AND source_row.status = 'active'
       AND source_row.serving_mode = 'serving'
       AND source_row.fetch_region = 'local'
  ) <> 2 THEN
    RAISE EXCEPTION 'binance local region move postflight failed';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM arena.sources AS source_row
     WHERE source_row.slug = 'bitmart_futures'
       AND source_row.fetch_region IS DISTINCT FROM 'vps_sg'
  ) THEN
    RAISE EXCEPTION 'binance local region move must not touch bitmart_futures';
  END IF;
END
$postflight$;

COMMIT;
