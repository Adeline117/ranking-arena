-- Migration: 20261118113319_binance_leaderboard_page_size_served_caps.sql
-- Description: binance_futures requests its leaderboard 30 rows per page and
--   binance_spot 100 rows per page, instead of 20. Only arena.sources.page_size
--   changes.
--
-- Why: a live board keeps moving while it is paged. At 20 rows per page one
--   binance_futures window is 660 requests and about 35 minutes, and every
--   capture since the 2026-11-18 restart ended with 3-151 rows seen twice and
--   a reported total that changed between pages (binance_spot: 124 requests,
--   1-20 duplicates), so the acquisition trust gate refused every board and
--   Binance could not be published. Fewer, larger pages give the board less
--   time to move: 440 requests for futures, 25 for spot.
--
--   These are the largest pages the endpoints serve. A read-only probe from
--   the local host on 2026-11-18 (real Chromium, the adapter's warm-up, 30D,
--   pages 1 and 2) found that the server silently truncates a larger request:
--     futures home-page/query-list   pageSize 100/200/500 -> 30 rows per page
--     spot    common/home-page-list  pageSize 100/200/500 -> 100 rows per page
--   with no row shared between page 1 and page 2 and the first 20 rows equal
--   to page 1 at pageSize 20. A configured size above the cap would make every
--   page look short and end the capture after one page.
--
-- The adapter reads src.page_size for the request body and the capture
-- records it as the configured page size, which the request evidence replays
-- (lib/ingest/leaderboard-request-evidence.ts), so no worker code changes. A
-- page shorter than the configured size before the reported total is reached
-- still ends the capture as a short page, which the trust gate refuses.
--
-- POSTDEPLOY, after 20261117204948 (which requires page_size 20 as its
-- pre-state). It touches no table 20261111192134 guards.
--
-- A missing row or any other pre-state (including a replay) refuses the whole
-- migration.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL search_path = pg_catalog, pg_temp;

LOCK TABLE arena.sources IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
DECLARE
  v_bad text;
BEGIN
  SELECT pg_catalog.string_agg(expected.slug, ', ' ORDER BY expected.slug)
    INTO v_bad
    FROM (VALUES ('binance_futures'::text), ('binance_spot')) AS expected(slug)
   WHERE NOT EXISTS (
     SELECT 1
       FROM arena.sources AS source_row
      WHERE source_row.slug = expected.slug
        AND source_row.adapter_slug = 'binance'
        AND source_row.status = 'active'
        AND source_row.page_size IS NOT DISTINCT FROM 20
   );
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'binance leaderboard page size pre-state drift: %', v_bad;
  END IF;
END
$preflight$;

UPDATE arena.sources
   SET page_size = CASE slug WHEN 'binance_futures' THEN 30 ELSE 100 END
 WHERE slug IN ('binance_futures', 'binance_spot')
   AND page_size IS NOT DISTINCT FROM 20;

DO $postflight$
BEGIN
  IF (
    SELECT pg_catalog.count(*)
      FROM arena.sources AS source_row
     WHERE (source_row.slug, source_row.page_size) IN (
             ('binance_futures', 30), ('binance_spot', 100)
           )
  ) <> 2 THEN
    RAISE EXCEPTION 'binance leaderboard page size postflight failed';
  END IF;
END
$postflight$;

COMMIT;
