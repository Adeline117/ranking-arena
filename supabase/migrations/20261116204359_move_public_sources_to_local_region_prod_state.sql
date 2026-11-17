-- Migration: 20261116204359_move_public_sources_to_local_region_prod_state.sql
-- Description: Owner decision (2026-11-15): activate okx_futures, okx_spot,
--   toobit_futures and xt_futures as publicly ranked sources fetched by the
--   `local` ingest region.
--
-- Target state (the state every publicly ranked source shares):
--   status = 'active'        the worker scheduler (lib/ingest/sources.ts
--                            getActiveSources) only schedules active rows
--   serving_mode = 'serving' arena_freshness_expected_sources, score inputs
--                            (20260716124500) and arena_visible_sources all
--                            require active AND serving
--   fetch_region = 'local'   the scheduler routes a source to the queue of its
--                            fetch_region; read-only probes from the local Mac
--                            on 2026-11-15 reached all four public boards
--                            (okx public-lead-traders, toobit leaders-new,
--                            xt leader-list-v3) with no geo-block, so the SG
--                            VPS exit the seed assumed is not needed.
--
-- Forward replacement for 20261115170535 (never applied). That file accepts
-- only the seed pre-state (blocked_pending_vps / inactive, legacy). Production
-- does not hold it: a rolled-back run there on 2026-11-17 refused with
-- "pre-state drift: okx_futures, okx_spot, toobit_futures, xt_futures",
-- because the four were already active/serving (okx and toobit on vps_sg,
-- xt on local; okx timeframes_derived {7,30}, page_size 20). Per row this file
-- accepts either pre-state and converges both to the same target; on
-- production the only change is fetch_region vps_sg -> local for okx_futures,
-- okx_spot and toobit_futures. Every other check is unchanged.
--
-- A missing row, any other state, a missing V3 capture contract, a
-- missing okx exhaustion contract, or a native window without an active
-- population metric contract refuses the whole migration. A replay finds okx
-- and toobit already local and refuses the same way.
--
-- POSTDEPLOY, after 20261115160917 and before 20261111192134: an active
-- source is scheduled for Tier-A at once, and Tier-A fails closed for a source
-- without a deployed captureLeaderboard and a registered capture contract, so
-- this runs only after the worker release that ships the captures and after
-- 160917 registers them. It touches no table 192134 guards.
--

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL search_path = pg_catalog, pg_temp;

LOCK TABLE arena.sources IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE arena.metric_source_contracts IN SHARE MODE;
LOCK TABLE arena.leaderboard_capture_contracts IN SHARE MODE;
LOCK TABLE arena.leaderboard_exhaustion_contracts IN SHARE MODE;

DO $preflight$
DECLARE
  v_bad text;
BEGIN
  IF pg_catalog.to_regclass('arena.sources') IS NULL
     OR pg_catalog.to_regclass('arena.metric_source_contracts') IS NULL
     OR pg_catalog.to_regclass('arena.leaderboard_capture_contracts') IS NULL
     OR pg_catalog.to_regclass('arena.leaderboard_exhaustion_contracts') IS NULL THEN
    RAISE EXCEPTION 'local public source activation requires the capture, metric-contract and exhaustion registries';
  END IF;

  -- Each row must equal one of its two accepted pre-states. 'seed' is the
  -- 20260610223356 seed after 20261115160917. 'production' is what production
  -- holds (read 2026-11-17): the four were already active/serving, okx still
  -- derives 7/30 and pages by 20, and only the fetch region of okx and toobit
  -- differs from the target.
  SELECT pg_catalog.string_agg(slug_row.slug, ', ' ORDER BY slug_row.slug)
    INTO v_bad
    FROM (
      VALUES ('okx_futures'::text), ('okx_spot'), ('toobit_futures'), ('xt_futures')
    ) AS slug_row(slug)
   WHERE NOT EXISTS (
     SELECT 1
       FROM (
         VALUES
           ('okx_futures'::text, 'okx'::text, 'futures'::text,
            'blocked_pending_vps'::text, 'legacy'::text, 'vps_sg'::text,
            ARRAY[90]::integer[], ARRAY[]::integer[], NULL::integer),
           ('okx_spot', 'okx', 'spot', 'blocked_pending_vps', 'legacy', 'vps_sg',
            ARRAY[90]::integer[], ARRAY[]::integer[], NULL::integer),
           ('toobit_futures', 'toobit', 'futures', 'blocked_pending_vps', 'legacy', 'vps_sg',
            ARRAY[7, 30, 90]::integer[], ARRAY[]::integer[], 1000),
           ('xt_futures', 'xt', 'futures', 'inactive', 'legacy', 'local',
            ARRAY[7, 30, 90]::integer[], ARRAY[]::integer[], 1000),
           ('okx_futures', 'okx', 'futures', 'active', 'serving', 'vps_sg',
            ARRAY[90]::integer[], ARRAY[7, 30]::integer[], 20),
           ('okx_spot', 'okx', 'spot', 'active', 'serving', 'vps_sg',
            ARRAY[90]::integer[], ARRAY[7, 30]::integer[], 20),
           ('toobit_futures', 'toobit', 'futures', 'active', 'serving', 'vps_sg',
            ARRAY[7, 30, 90]::integer[], ARRAY[]::integer[], 1000),
           ('xt_futures', 'xt', 'futures', 'active', 'serving', 'local',
            ARRAY[7, 30, 90]::integer[], ARRAY[]::integer[], 1000)
       ) AS expected(slug, adapter_slug, product_type, status, serving_mode,
                     fetch_region, timeframes_native, timeframes_derived, page_size)
       JOIN arena.sources AS source_row
         ON source_row.slug = expected.slug
        AND source_row.adapter_slug = expected.adapter_slug
        AND source_row.product_type = expected.product_type
        AND source_row.status = expected.status
        AND source_row.serving_mode = expected.serving_mode
        AND source_row.fetch_region = expected.fetch_region
        AND source_row.currency = 'USDT'
        AND source_row.timeframes_native = expected.timeframes_native
        AND source_row.timeframes_derived = expected.timeframes_derived
        AND source_row.page_size IS NOT DISTINCT FROM expected.page_size
      WHERE expected.slug = slug_row.slug
   );
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'local public source activation pre-state drift: %', v_bad;
  END IF;

  SELECT pg_catalog.string_agg(source_row.slug, ', ' ORDER BY source_row.slug)
    INTO v_bad
    FROM arena.sources AS source_row
   WHERE source_row.slug IN ('okx_futures', 'okx_spot', 'toobit_futures', 'xt_futures')
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
    RAISE EXCEPTION 'local public source activation requires the 20261115160917 V3 capture contract for: %', v_bad;
  END IF;

  SELECT pg_catalog.string_agg(source_row.slug, ', ' ORDER BY source_row.slug)
    INTO v_bad
    FROM arena.sources AS source_row
   WHERE source_row.slug IN ('okx_futures', 'okx_spot')
     AND NOT EXISTS (
       SELECT 1
         FROM arena.leaderboard_exhaustion_contracts AS contract
        WHERE contract.source_id = source_row.id
          AND contract.completeness_contract =
              'arena.ingest.leaderboard-exhaustion-completeness@1'
     );
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'local public source activation requires the 20261115160917 exhaustion contract for: %', v_bad;
  END IF;

  SELECT pg_catalog.string_agg(
           source_row.slug || ':' || window_days::text || 'd',
           ', ' ORDER BY source_row.slug, window_days
         )
    INTO v_bad
    FROM arena.sources AS source_row
    CROSS JOIN LATERAL pg_catalog.unnest(source_row.timeframes_native) AS window_days
   WHERE source_row.slug IN ('okx_futures', 'okx_spot', 'toobit_futures', 'xt_futures')
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
    RAISE EXCEPTION 'local public source activation needs a population metric contract for: %', v_bad;
  END IF;
END
$preflight$;

-- The preflight proved every row is in an accepted pre-state, so the
-- slug list alone identifies the rows; only rows not yet at the target change.
UPDATE arena.sources
   SET status = 'active',
       serving_mode = 'serving',
       fetch_region = 'local'
 WHERE slug IN ('okx_futures', 'okx_spot', 'toobit_futures', 'xt_futures')
   AND (status, serving_mode, fetch_region) IS DISTINCT FROM ('active', 'serving', 'local');

DO $postflight$
BEGIN
  IF (
    SELECT pg_catalog.count(*)
      FROM arena.sources AS source_row
     WHERE source_row.slug IN ('okx_futures', 'okx_spot', 'toobit_futures', 'xt_futures')
       AND source_row.status = 'active'
       AND source_row.serving_mode = 'serving'
       AND source_row.fetch_region = 'local'
  ) <> 4 THEN
    RAISE EXCEPTION 'local public source activation postflight failed';
  END IF;
END
$postflight$;

COMMIT;
