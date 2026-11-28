-- Rollback of 20261128001007_trader_stats_drop_as_of_index.sql.
-- Rebuilds idx_arena_trader_stats_as_of exactly as 20260610223901 created it,
-- without blocking writes. Not a migration: applied by hand only inside an
-- owner-approved window.
--
-- CREATE INDEX CONCURRENTLY cannot run inside a transaction: run this file
-- with psql in autocommit mode (no -1 / --single-transaction). A build that
-- fails leaves an INVALID index; the check below then fails, and that index
-- must be dropped (DROP INDEX CONCURRENTLY) before this file is re-run.
-- Expected duration: about a minute (the table is about 340 MB of heap).

SET lock_timeout = '3s';
SET statement_timeout = 0;
SET search_path = pg_catalog, pg_temp;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_arena_trader_stats_as_of
  ON arena.trader_stats (as_of);

DO $postflight$
DECLARE
  v_index regclass := pg_catalog.to_regclass('arena.idx_arena_trader_stats_as_of');
BEGIN
  IF v_index IS NULL
     OR pg_catalog.pg_get_indexdef(v_index) IS DISTINCT FROM
        'CREATE INDEX idx_arena_trader_stats_as_of ON arena.trader_stats USING btree (as_of)'
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_index AS i WHERE i.indexrelid = v_index AND i.indisvalid) THEN
    RAISE EXCEPTION 'idx_arena_trader_stats_as_of was not rebuilt as a valid index with the 20260610223901 definition';
  END IF;
END
$postflight$;
