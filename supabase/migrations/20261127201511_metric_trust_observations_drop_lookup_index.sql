-- Migration: 20261127201511_metric_trust_observations_drop_lookup_index.sql
-- Description: drop idx_arena_metric_trust_observations_lookup, an index of
--   arena.metric_trust_observations that no query uses.
--
-- Why: the Tier-A publication transaction writes one observation per trader
--   and metric, about 100,000 rows for the bybit_mt5 board, inside a write
--   deadline of 80-120 s. On 2026-11-27 that board missed the deadline twice
--   (publication normally 78-95 s); the observation insert is its second
--   slowest statement (up to 32.4 s). Every inserted row maintains six
--   indexes. lookup (source_id, timeframe, metric, trader_id,
--   source_as_of DESC) is 393 MB and has 0 scans in production (statistics
--   never reset). It was created with the shadow gate (20260721120000); no
--   view, function or application query in this repository reads the latest
--   observation by (source, window, metric, trader).
--
-- Not dropped: idx_arena_metric_trust_observations_run (source_id,
--   source_run_id, snapshot_id), also 0 scans. The metric-trust readiness
--   proofs show it is what bounds the readiness count: with only
--   idx_..._source_run the planner hash-joins a full scan (200,036 of 200,036
--   observations read instead of 33). It is 59 MB. The primary key, the
--   (contract_id, trader_id, snapshot_id) unique key, entry and source_run
--   stay as well.
--
-- Locking: DROP INDEX takes ACCESS EXCLUSIVE on the table for the drop
--   itself, a catalog change that takes milliseconds. lock_timeout is 3 s, so
--   if a publication holds the table the migration fails without waiting and
--   can be re-run. Apply between scoring and Tier-A publication windows.
--
-- Safety: refuses unless the index, if it still exists, has exactly the
--   production definition, is valid and backs no constraint; an index
--   someone changed is refused, not dropped. A replay (already gone) is a
--   no-op. Afterwards the five remaining indexes must exist, valid, with
--   their production definitions. No table, column, trigger or constraint
--   changes, and nothing the worker startup gate pins.
--
-- Rollback: scripts/maintenance/rollbacks/20261127201511_metric_trust_observations_drop_lookup_index.rollback.sql
--   (CREATE INDEX CONCURRENTLY, outside a transaction).
--
-- POSTDEPLOY. No application or worker release depends on it.
-- Generated only; not applied to any environment.

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';
SET LOCAL search_path = pg_catalog, pg_temp;

DO $preflight$
DECLARE
  v_index regclass;
  v_def text;
BEGIN
  IF pg_catalog.to_regclass('arena.metric_trust_observations') IS NULL THEN
    RAISE EXCEPTION 'arena.metric_trust_observations is missing';
  END IF;

  v_index := pg_catalog.to_regclass('arena.idx_arena_metric_trust_observations_lookup');
  IF v_index IS NULL THEN
    RETURN;  -- already dropped (replay)
  END IF;

  v_def := pg_catalog.pg_get_indexdef(v_index);
  IF v_def IS DISTINCT FROM
     'CREATE INDEX idx_arena_metric_trust_observations_lookup ON arena.metric_trust_observations USING btree (source_id, timeframe, metric, trader_id, source_as_of DESC)' THEN
    RAISE EXCEPTION 'idx_arena_metric_trust_observations_lookup is not the expected definition (found: %); refusing', v_def;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_index AS i
     WHERE i.indexrelid = v_index
       AND i.indrelid = 'arena.metric_trust_observations'::regclass
       AND i.indisvalid
       AND NOT i.indisunique
       AND NOT i.indisprimary
  ) THEN
    RAISE EXCEPTION 'idx_arena_metric_trust_observations_lookup is not a valid plain index of arena.metric_trust_observations; refusing';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_constraint AS c WHERE c.conindid = v_index) THEN
    RAISE EXCEPTION 'idx_arena_metric_trust_observations_lookup backs a constraint; refusing';
  END IF;
END
$preflight$;

DROP INDEX IF EXISTS arena.idx_arena_metric_trust_observations_lookup;

DO $postflight$
DECLARE
  v_kept constant jsonb := pg_catalog.jsonb_build_object(
    'metric_trust_observations_pkey',
    'CREATE UNIQUE INDEX metric_trust_observations_pkey ON arena.metric_trust_observations USING btree (id)',
    'metric_trust_observations_contract_id_trader_id_snapshot_id_key',
    'CREATE UNIQUE INDEX metric_trust_observations_contract_id_trader_id_snapshot_id_key ON arena.metric_trust_observations USING btree (contract_id, trader_id, snapshot_id)',
    'idx_arena_metric_trust_observations_entry',
    'CREATE INDEX idx_arena_metric_trust_observations_entry ON arena.metric_trust_observations USING btree (snapshot_id, trader_id, snapshot_scraped_at)',
    'idx_arena_metric_trust_observations_source_run',
    'CREATE INDEX idx_arena_metric_trust_observations_source_run ON arena.metric_trust_observations USING btree (source_run_id, id)',
    'idx_arena_metric_trust_observations_run',
    'CREATE INDEX idx_arena_metric_trust_observations_run ON arena.metric_trust_observations USING btree (source_id, source_run_id, snapshot_id)'
  );
  v_name text;
  v_index regclass;
BEGIN
  IF pg_catalog.to_regclass('arena.idx_arena_metric_trust_observations_lookup') IS NOT NULL THEN
    RAISE EXCEPTION 'idx_arena_metric_trust_observations_lookup still exists';
  END IF;

  FOR v_name IN SELECT pg_catalog.jsonb_object_keys(v_kept) LOOP
    v_index := pg_catalog.to_regclass('arena.' || v_name);
    IF v_index IS NULL
       OR pg_catalog.pg_get_indexdef(v_index) IS DISTINCT FROM v_kept->>v_name
       OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_index AS i WHERE i.indexrelid = v_index AND i.indisvalid) THEN
      RAISE EXCEPTION 'kept index % is missing, invalid or changed', v_name;
    END IF;
  END LOOP;
END
$postflight$;

COMMIT;
