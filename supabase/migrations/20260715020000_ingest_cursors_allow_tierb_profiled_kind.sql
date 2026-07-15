-- Tier-B profile crawls persist a per-trader freshness marker so deadline-
-- chunked jobs resume from stale traders instead of restarting at rank one.
-- The worker has written kind='tierb_profiled' since that marker was added,
-- but production still only permits the older history and series kinds.
-- Relaxing the CHECK is backwards-compatible with every existing row.
ALTER TABLE arena.ingest_cursors
  DROP CONSTRAINT IF EXISTS ingest_cursors_kind_check;

ALTER TABLE arena.ingest_cursors
  ADD CONSTRAINT ingest_cursors_kind_check
  CHECK (
    kind = ANY (
      ARRAY[
        'position_history',
        'orders',
        'transfers',
        'copiers',
        'series_backfill',
        'tierb_profiled'
      ]
    )
  );
