-- Restore arena_score index lost during partition swap (20260405f)
-- Root cause: precompute-composite queries ORDER BY arena_score DESC
-- on trader_snapshots_v2 WHERE window = '90D' — without this index,
-- it does a full sequential scan + sort on 100K+ rows, hitting
-- Supabase's statement_timeout (observed: 8.2s → cancelled).
--
-- Original index was created in 20260330b but not recreated in 20260405f Step 6.
-- Note: partitioned tables cannot use CONCURRENTLY; the parent-level CREATE INDEX
-- propagates to all existing and future partitions automatically.

CREATE INDEX IF NOT EXISTS idx_snapshots_v2_window_arena_score
ON trader_snapshots_v2 ("window", arena_score DESC NULLS LAST)
WHERE arena_score IS NOT NULL;
