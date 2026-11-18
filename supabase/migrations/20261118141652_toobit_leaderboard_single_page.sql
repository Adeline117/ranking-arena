-- Migration: 20261118141652_toobit_leaderboard_single_page.sql
-- Description: toobit_futures requests its leaderboard in one page: `size`
--   5000 instead of 1000. Only arena.sources.page_size changes.
--
-- Why: the board (2,602 traders) was read as three pages of 1000. The server
--   orders traders with equal values differently between requests, so on some
--   captures 53-186 traders were returned on two pages and as many on none
--   (four captures since the 2026-11-18 restart: 181, 53, 115 and 186
--   duplicate rows), and the acquisition trust gate refused the board. This is
--   unstable paging on the server, not a board that moved: one request returns
--   every trader exactly once.
--
--   A read-only probe on 2026-11-18 (leaders-new?page=1&size=5000) returned,
--   for dataType 7, 30 and 90 alike: HTTP 200, total 2602, 2602 rows, 2602
--   distinct leaderUserIds, pages 1. 5000 leaves room for the board to nearly
--   double; past that the capture simply pages again.
--
-- The adapter reads src.page_size for the request and the capture records it
-- as the configured page size, so no worker code changes. The total mode and
-- its zero tolerance are unchanged: the accepted rows must still equal the
-- reported total with no duplicate.
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

DO $preflight$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM arena.sources AS source_row
     WHERE source_row.slug = 'toobit_futures'
       AND source_row.adapter_slug = 'toobit'
       AND source_row.status = 'active'
       AND source_row.page_size IS NOT DISTINCT FROM 1000
  ) THEN
    RAISE EXCEPTION 'toobit leaderboard page size pre-state drift: toobit_futures';
  END IF;
END
$preflight$;

UPDATE arena.sources
   SET page_size = 5000
 WHERE slug = 'toobit_futures'
   AND page_size IS NOT DISTINCT FROM 1000;

DO $postflight$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM arena.sources AS source_row
     WHERE source_row.slug = 'toobit_futures'
       AND source_row.page_size = 5000
  ) THEN
    RAISE EXCEPTION 'toobit leaderboard page size postflight failed';
  END IF;
END
$postflight$;

COMMIT;
