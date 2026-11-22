-- Migration: 20261118150737_public_boards_larger_served_pages.sql
-- Description: Four public boards request larger pages. Only
--   arena.sources.page_size changes:
--     xt_futures       1000 -> 5000  (the whole board in one request)
--     bitget_cfd         30 -> 50
--     bitget_spot        30 -> 50
--     bybit_copytrade    16 -> 50
--
-- Why: these boards were refused by the acquisition trust gate on some
--   captures since the 2026-11-18 restart because a few rows repeated across
--   pages or the reported total changed between pages (xt_futures 90d: 1-2
--   duplicates over 2 pages; bitget_cfd: 1-3 over 7 pages; bitget_spot: 1-27
--   over 181 pages and ~10 minutes; bybit_copytrade: total 7037-7040 over 440
--   pages and ~23 minutes). Fewer, larger pages leave a board less time to
--   move and fewer page boundaries for tied rows to cross.
--
--   Read-only probes on 2026-11-18 found what each endpoint serves:
--     xt        ps=3000 or 5000 returns all 1,969 traders in one page for the
--               7/30/90 windows (1,969 distinct = total; page 2 empty)
--     bitget    pageSize 50 returns 50 rows, page 2 shares none with page 1;
--               100/200/500 silently fall back to 20 rows per page
--     bybit     pageSize 16/30/50 are served as asked (totalPageCount
--               440/235/141, no overlap); 100 is cut to 50
--   bybit_mt5 (pageSize ignored, fixed 16) and okx_web3_solana (fixed 20)
--   cannot be read in larger pages and are not changed. bitget_futures and
--   xt_spot have no registered capture contract and are not changed.
--
-- Each adapter reads src.page_size for the request and the capture records it
-- as the configured page size, so no worker code changes. The total mode and
-- its zero tolerance are unchanged for all four.
--
-- POSTDEPLOY. It touches no table 20261111192134 guards.
--
-- A missing row or any other pre-state (including a replay) refuses the whole
-- migration.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL search_path = pg_catalog, pg_temp;

LOCK TABLE arena.sources IN SHARE ROW EXCLUSIVE MODE;

-- Session-local seed (pg_temp); it disappears with the applying session.
CREATE TEMPORARY TABLE served_page_size_seed (
  source_slug text PRIMARY KEY,
  adapter_slug text NOT NULL,
  page_size_before integer NOT NULL,
  page_size_after integer NOT NULL
);

INSERT INTO served_page_size_seed VALUES
  ('xt_futures', 'xt', 1000, 5000),
  ('bitget_cfd', 'bitget', 30, 50),
  ('bitget_spot', 'bitget', 30, 50),
  ('bybit_copytrade', 'bybit_copytrade', 16, 50);

DO $preflight$
DECLARE
  v_bad text;
BEGIN
  SELECT pg_catalog.string_agg(seed.source_slug, ', ' ORDER BY seed.source_slug)
    INTO v_bad
    FROM served_page_size_seed AS seed
   WHERE NOT EXISTS (
     SELECT 1
       FROM arena.sources AS source_row
      WHERE source_row.slug = seed.source_slug
        AND source_row.adapter_slug = seed.adapter_slug
        AND source_row.status = 'active'
        AND source_row.page_size IS NOT DISTINCT FROM seed.page_size_before
   );
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'served page size pre-state drift: %', v_bad;
  END IF;
END
$preflight$;

UPDATE arena.sources AS source_row
   SET page_size = seed.page_size_after
  FROM served_page_size_seed AS seed
 WHERE source_row.slug = seed.source_slug
   AND source_row.page_size IS NOT DISTINCT FROM seed.page_size_before;

DO $postflight$
BEGIN
  IF (
    SELECT pg_catalog.count(*)
      FROM served_page_size_seed AS seed
      JOIN arena.sources AS source_row
        ON source_row.slug = seed.source_slug
       AND source_row.page_size = seed.page_size_after
  ) <> 4 THEN
    RAISE EXCEPTION 'served page size postflight failed';
  END IF;
END
$postflight$;

COMMIT;
