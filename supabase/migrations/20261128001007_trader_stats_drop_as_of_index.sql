-- Migration: 20261128001007_trader_stats_drop_as_of_index.sql
-- Description: drop idx_arena_trader_stats_as_of, an index of
--   arena.trader_stats that no query uses and that keeps every board upsert
--   from being a HOT update.
--
-- Why: a Tier-A publication upserts one arena.trader_stats row per trader
--   (about 32,700 for each bybit_mt5 window) inside its write deadline, and
--   by design every upsert moves as_of to the new scrape. While as_of is
--   indexed, no such update can be HOT: each one writes a new heap tuple and
--   a new entry in all three indexes (production: 340,727 updates, 21 % HOT).
--   bybit_mt5 30D took 110.8 s end to end on 2026-11-28 07:50, the slowest in
--   three days. idx_arena_trader_stats_as_of is 218 MB and has 0 scans in
--   production (statistics never reset). It was created with the table
--   (20260610223901); every freshness rule in this repository (48 h as_of
--   windows) reads a trader's rows by the primary key and tests as_of per
--   row, and nothing ranges over as_of across traders.
--
-- After the drop, an upsert that leaves roi unchanged changes no indexed
--   column and can be HOT when its page has room.
--
-- Not dropped: trader_stats_pkey (every upsert and reader) and
--   idx_arena_trader_stats_tf_roi (118 scans, derived-board synthesis).
--
-- Locking: DROP INDEX takes ACCESS EXCLUSIVE on the table for the drop
--   itself, a catalog change that takes milliseconds. lock_timeout is 3 s, so
--   if a publication holds the table the migration fails without waiting and
--   can be re-run. Apply between Tier-A publication windows.
--
-- Safety: refuses unless the index, if it still exists, has exactly the
--   production definition, is valid and backs no constraint; an index
--   someone changed is refused, not dropped. A replay (already gone) is a
--   no-op. Afterwards the two remaining indexes must exist, valid, with their
--   production definitions. No table, column, trigger or constraint changes,
--   and nothing the worker startup gate pins. Independent of
--   20261128001008 (traders), which can be applied or rolled back alone.
--
-- Rollback: scripts/maintenance/rollbacks/20261128001007_trader_stats_drop_as_of_index.rollback.sql
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

  v_index := pg_catalog.to_regclass('arena.idx_arena_trader_stats_as_of');
  IF v_index IS NULL THEN
    RETURN;  -- already dropped (replay)
  END IF;

  v_def := pg_catalog.pg_get_indexdef(v_index);
  IF v_def IS DISTINCT FROM
     'CREATE INDEX idx_arena_trader_stats_as_of ON arena.trader_stats USING btree (as_of)' THEN
    RAISE EXCEPTION 'idx_arena_trader_stats_as_of is not the expected definition (found: %); refusing', v_def;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_index AS i
     WHERE i.indexrelid = v_index
       AND i.indrelid = 'arena.trader_stats'::regclass
       AND i.indisvalid
       AND NOT i.indisunique
       AND NOT i.indisprimary
  ) THEN
    RAISE EXCEPTION 'idx_arena_trader_stats_as_of is not a valid plain index of arena.trader_stats; refusing';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_constraint AS c WHERE c.conindid = v_index) THEN
    RAISE EXCEPTION 'idx_arena_trader_stats_as_of backs a constraint; refusing';
  END IF;
END
$preflight$;

DROP INDEX IF EXISTS arena.idx_arena_trader_stats_as_of;

DO $postflight$
DECLARE
  v_kept constant jsonb := pg_catalog.jsonb_build_object(
    'trader_stats_pkey',
    'CREATE UNIQUE INDEX trader_stats_pkey ON arena.trader_stats USING btree (trader_id, timeframe)',
    'idx_arena_trader_stats_tf_roi',
    'CREATE INDEX idx_arena_trader_stats_tf_roi ON arena.trader_stats USING btree (timeframe, roi DESC NULLS LAST)'
  );
  v_name text;
  v_index regclass;
BEGIN
  IF pg_catalog.to_regclass('arena.idx_arena_trader_stats_as_of') IS NOT NULL THEN
    RAISE EXCEPTION 'idx_arena_trader_stats_as_of still exists';
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
