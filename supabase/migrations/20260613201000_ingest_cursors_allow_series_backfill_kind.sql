-- Root-cause fix (2026-06-13): tier-B-series backfill (worker/src/ingest/
-- processors/tier-b-series.ts) writes arena.ingest_cursors with
-- kind='series_backfill' (sentinel trader_id = -source_id), but the table's
-- CHECK constraint only allowed the four history kinds — so every
-- series-backfill cursor write threw
--   "new row for relation ingest_cursors violates check constraint
--    ingest_cursors_kind_check"
-- aborting the job. Classic schema drift: the processor added a new kind, the
-- constraint was never widened. Applied to prod via MCP; this file keeps the
-- repo in sync. Relaxing-only (adds a value) → no existing row can violate it.
ALTER TABLE arena.ingest_cursors DROP CONSTRAINT IF EXISTS ingest_cursors_kind_check;
ALTER TABLE arena.ingest_cursors ADD CONSTRAINT ingest_cursors_kind_check
  CHECK (kind = ANY (ARRAY['position_history', 'orders', 'transfers', 'copiers', 'series_backfill']));
