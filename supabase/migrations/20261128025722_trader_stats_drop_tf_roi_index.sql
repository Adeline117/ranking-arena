-- Migration: 20261128025722_trader_stats_drop_tf_roi_index.sql
-- Description: drop idx_arena_trader_stats_tf_roi, the last secondary index
--   of arena.trader_stats, so that every board upsert can be a HOT update
--   and no publication pays for a random insert into it.
--
-- Why: after 20261128001007 (as_of index) and 20261128022325 (fillfactor 90)
--   an upsert whose roi changed still cannot be HOT, and each one inserts a
--   new entry at a random place of this 101 MB index: it is the third
--   largest source of index block reads of a publication (229,167 reads,
--   production pg_statio_user_indexes 2026-11-28 10:51).
--   It was created with the table (20260610223901) for the derived-board
--   synthesis ranked by roi. In production it has 118 scans in total that
--   read 26,562,288 entries, about 225,000 per scan: one whole timeframe
--   each time, not a top-N by roi. The last scan was 2026-11-28 06:06;
--   none in the 08:0x and 10:0x scoring windows after it.
--   * derive-boards (worker/src/ingest/processors/derive-boards.ts) selects
--     by trader id list and source; its production plan (EXPLAIN,
--     2026-11-28) walks traders_pkey and trader_stats_pkey.
--   * arena.publication_score_rows_json@4 (20261120233328) joins
--     trader_stats on (trader_id, timeframe); its production plan for all
--     three windows (EXPLAIN, 2026-11-28 10:56) uses trader_stats_pkey.
--   * onchain-enrich (worker/src/ingest/processors/onchain-enrich.ts) uses
--     the traders source key and trader_stats_pkey (EXPLAIN, 2026-11-28).
--   A plan that read a whole timeframe through this index can read it with a
--   sequential scan of the table instead (about 43,000 pages, sequential)
--   rather than 225,000 random heap fetches, so no reader gets
--   materially slower.
--
-- Afterwards trader_stats_pkey is the table's only index: an upsert changes
--   no indexed column, and with fillfactor 90 it is HOT whenever its page
--   has room.
--
-- Replay note: 20261128001007's postflight lists this index among the ones it
--   keeps, so 20261128001007 must not be re-applied after this migration (it
--   is applied in production; the launch runner applies one file at a time
--   and never re-runs an applied file). A whole-database rehearsal applies
--   both in order and is unaffected.
--
-- Locking: DROP INDEX takes ACCESS EXCLUSIVE on the table for the drop
--   itself, a catalog change that takes milliseconds. lock_timeout is 3 s, so
--   if a publication holds the table the migration fails without waiting and
--   can be re-run. Apply between Tier-A publication and scoring windows.
--
-- Safety: refuses unless the index, if it still exists, has exactly the
--   production definition, is valid and backs no constraint; an index
--   someone changed is refused, not dropped. A replay (already gone) is a
--   no-op. Afterwards trader_stats_pkey must be the only index, valid, with
--   its production definition. No table, column, trigger, constraint or
--   storage parameter changes, and nothing the worker startup gate
--   (worker/src/ingest/attempt-bound-capture-readiness.ts) reads.
--
-- Rollback: scripts/maintenance/rollbacks/20261128025722_trader_stats_drop_tf_roi_index.rollback.sql
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
  IF pg_catalog.to_regclass('arena.trader_stats') IS NULL THEN
    RAISE EXCEPTION 'arena.trader_stats is missing';
  END IF;

  v_index := pg_catalog.to_regclass('arena.idx_arena_trader_stats_tf_roi');
  IF v_index IS NULL THEN
    RETURN;  -- already dropped (replay)
  END IF;

  v_def := pg_catalog.pg_get_indexdef(v_index);
  IF v_def IS DISTINCT FROM
     'CREATE INDEX idx_arena_trader_stats_tf_roi ON arena.trader_stats USING btree (timeframe, roi DESC NULLS LAST)' THEN
    RAISE EXCEPTION 'idx_arena_trader_stats_tf_roi is not the expected definition (found: %); refusing', v_def;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_index AS i
     WHERE i.indexrelid = v_index
       AND i.indrelid = 'arena.trader_stats'::regclass
       AND i.indisvalid
       AND NOT i.indisunique
       AND NOT i.indisprimary
  ) THEN
    RAISE EXCEPTION 'idx_arena_trader_stats_tf_roi is not a valid plain index of arena.trader_stats; refusing';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_constraint AS c WHERE c.conindid = v_index) THEN
    RAISE EXCEPTION 'idx_arena_trader_stats_tf_roi backs a constraint; refusing';
  END IF;
END
$preflight$;

DROP INDEX IF EXISTS arena.idx_arena_trader_stats_tf_roi;

DO $postflight$
DECLARE
  v_kept constant jsonb := pg_catalog.jsonb_build_object(
    'trader_stats_pkey',
    'CREATE UNIQUE INDEX trader_stats_pkey ON arena.trader_stats USING btree (trader_id, timeframe)'
  );
  v_name text;
  v_index regclass;
BEGIN
  IF pg_catalog.to_regclass('arena.idx_arena_trader_stats_tf_roi') IS NOT NULL THEN
    RAISE EXCEPTION 'idx_arena_trader_stats_tf_roi still exists';
  END IF;

  IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_index AS i
       WHERE i.indrelid = 'arena.trader_stats'::regclass) <> 1 THEN
    RAISE EXCEPTION 'arena.trader_stats has indexes other than trader_stats_pkey';
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
