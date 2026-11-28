-- Migration: 20261128022326_traders_fillfactor_90.sql
-- Description: set fillfactor = 90 on arena.traders so that the board
--   upserts of a Tier-A publication find room for a HOT update on the row's
--   own page.
--
-- Why: since 20261128001007/001008 (applied 2026-11-28 08:36) no index
--   blocks HOT updates of the board upsert any more. Production over the
--   next 104 minutes (37 board publications): traders 109,671 updates, 79 %
--   HOT (0 % before), and 21,938 (20 %) moved to a new page. Nearly every
--   remaining non-HOT update was placed on another page because the row's
--   page had no free space (n_tup_newpage_upd), not because an indexed
--   column changed. With fillfactor 100 (the default; reloptions empty in
--   production) pages are packed full, and so are the pages non-HOT updates
--   move rows to.
--
-- What changes: only the storage parameter. ALTER TABLE ... SET
--   (fillfactor = 90) does not rewrite the table. From now on inserts and
--   non-HOT updates leave 10 % of each page they fill free, so the next
--   update of those rows can be HOT; pages already full stay full until
--   pruning or vacuum frees them, so the HOT share rises gradually. Existing
--   rows are not touched.
--
-- arena.traders is a plain table (relkind r, not partitioned and not a
--   partition; created by 20260610223752 without PARTITION BY), so the parameter is
--   set on the table itself and no partition setup elsewhere needs it. The
--   preflight refuses a partitioned table or a partition.
--
-- Locking: SHARE UPDATE EXCLUSIVE on the table for a catalog change that
--   takes milliseconds. It does not conflict with the publication's reads
--   and writes (ROW EXCLUSIVE); it conflicts with VACUUM, ANALYZE and other
--   DDL. lock_timeout is 3 s: a timeout changes nothing and can be retried.
--
-- Safety: refuses unless the table's reloptions are empty, or already
--   exactly {fillfactor=90} (replay, a no-op). Afterwards reloptions must be
--   exactly {fillfactor=90}. No column, index, trigger, constraint, policy or
--   privilege changes, and nothing the worker startup gate
--   (worker/src/ingest/attempt-bound-capture-readiness.ts) reads: it does not
--   read reloptions and does not list arena.traders. Independent of
--   20261128022325 (trader_stats), which can be applied or rolled back alone.
--
-- Rollback: scripts/maintenance/rollbacks/20261128022326_traders_fillfactor_90.rollback.sql
--   (ALTER TABLE ... RESET (fillfactor), same lock).
--
-- POSTDEPLOY. No application or worker release depends on it.
-- Generated only; not applied to any environment.

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';
SET LOCAL search_path = pg_catalog, pg_temp;

DO $preflight$
DECLARE
  v_table regclass := pg_catalog.to_regclass('arena.traders');
  v_kind "char";
  v_is_partition boolean;
  v_options text[];
BEGIN
  IF v_table IS NULL THEN
    RAISE EXCEPTION 'arena.traders is missing';
  END IF;

  SELECT c.relkind, c.relispartition, c.reloptions
    INTO v_kind, v_is_partition, v_options
    FROM pg_catalog.pg_class AS c
   WHERE c.oid = v_table;

  IF v_kind IS DISTINCT FROM 'r' OR v_is_partition THEN
    RAISE EXCEPTION 'arena.traders is not a plain, unpartitioned table (relkind %, partition %); refusing', v_kind, v_is_partition;
  END IF;
  IF v_options IS NOT NULL
     AND v_options IS DISTINCT FROM ARRAY['fillfactor=90']::text[] THEN
    RAISE EXCEPTION 'arena.traders already has storage parameters % ; refusing', v_options;
  END IF;
END
$preflight$;

ALTER TABLE arena.traders SET (fillfactor = 90);

DO $postflight$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_class AS c
     WHERE c.oid = 'arena.traders'::regclass
       AND c.relkind = 'r'
       AND c.reloptions IS NOT DISTINCT FROM ARRAY['fillfactor=90']::text[]
  ) THEN
    RAISE EXCEPTION 'arena.traders does not have exactly fillfactor=90';
  END IF;
END
$postflight$;

COMMIT;
