-- Rollback of 20261127201511_metric_trust_observations_drop_lookup_index.sql.
-- Rebuilds idx_arena_metric_trust_observations_lookup exactly as
-- 20260721120000 created it, without blocking writes. Not a migration:
-- applied by hand only inside an owner-approved window.
--
-- CREATE INDEX CONCURRENTLY cannot run inside a transaction: run this file
-- with psql in autocommit mode (no -1 / --single-transaction). A build that
-- fails leaves an INVALID index; the check below then fails, and that index
-- must be dropped (DROP INDEX CONCURRENTLY) before this file is re-run.
-- Expected duration: minutes (the table is about 4.4 GB of heap).

SET lock_timeout = '3s';
SET statement_timeout = 0;
SET search_path = pg_catalog, pg_temp;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_arena_metric_trust_observations_lookup
  ON arena.metric_trust_observations
    (source_id, timeframe, metric, trader_id, source_as_of DESC);

DO $postflight$
DECLARE
  v_index regclass := pg_catalog.to_regclass('arena.idx_arena_metric_trust_observations_lookup');
BEGIN
  IF v_index IS NULL
     OR pg_catalog.pg_get_indexdef(v_index) IS DISTINCT FROM
        'CREATE INDEX idx_arena_metric_trust_observations_lookup ON arena.metric_trust_observations USING btree (source_id, timeframe, metric, trader_id, source_as_of DESC)'
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_index AS i WHERE i.indexrelid = v_index AND i.indisvalid) THEN
    RAISE EXCEPTION 'idx_arena_metric_trust_observations_lookup was not rebuilt as a valid index with the 20260721120000 definition';
  END IF;
END
$postflight$;
