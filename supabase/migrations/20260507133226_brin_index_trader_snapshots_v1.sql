-- Migration: BRIN index on trader_snapshots v1 captured_at
-- Purpose: trader_snapshots v1 has millions of rows with B-tree indexes (GBs).
--          BRIN (Block Range Index) is 100x smaller than B-tree for time-series data
--          and performs comparably for range scans on naturally-ordered columns.
--          Also drops the old B-tree on captured_at (redundant once BRIN exists).
--
-- BRIN works because captured_at is append-only (new rows have larger timestamps),
-- so physical block order correlates with column value. pages_per_range=32 means
-- each BRIN entry covers 32 pages (~256KB), keeping the index under 1MB even for
-- millions of rows.

-- Add BRIN index (tiny: ~100KB vs B-tree ~500MB on millions of rows)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_trader_snapshots_captured_brin
  ON trader_snapshots USING brin(captured_at) WITH (pages_per_range = 32);

-- Drop redundant B-tree on captured_at (replaced by BRIN above)
-- The B-tree was created in 00001_initial_schema.sql and wastes hundreds of MB.
DROP INDEX CONCURRENTLY IF EXISTS idx_trader_snapshots_captured_at;

-- Also add BRIN on arena_score for range queries (e.g., "score > 50")
-- Not as effective as captured_at BRIN (scores aren't perfectly ordered on disk)
-- but still much smaller than a B-tree for rarely-used queries on v1 table.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_trader_snapshots_arena_score_brin
  ON trader_snapshots USING brin(arena_score) WITH (pages_per_range = 64);
