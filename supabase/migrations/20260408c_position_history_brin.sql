-- BRIN index on trader_position_history.created_at
--
-- ROOT CAUSE: trader_position_history has 69M rows / 13GB but no index on
-- created_at. Time-range queries (e.g., "rows from last 7 days") trigger
-- a full sequential scan. Even MIN/MAX(created_at) times out.
--
-- FIX: BRIN (Block Range INdex) is perfect for time-series data inserted
-- in append-only fashion. created_at correlates with physical block order
-- (rows inserted in time order land in adjacent pages), so BRIN gets ~99%
-- accuracy with index size measured in KB, not GB.
--
-- A regular B-tree on created_at would be ~3GB. BRIN is ~50KB.
-- Build time: BRIN scans the table sequentially once (~30-60 seconds for 13GB),
-- vs B-tree which would take 10+ minutes.
--
-- Use case: time-range filtering, retention cleanup, monitoring queries.

CREATE INDEX IF NOT EXISTS idx_position_history_created_at_brin
ON trader_position_history
USING brin (created_at) WITH (pages_per_range = 32);

-- Also helps for close_time queries (positions closed in a time range)
CREATE INDEX IF NOT EXISTS idx_position_history_close_time_brin
ON trader_position_history
USING brin (close_time) WITH (pages_per_range = 32)
WHERE close_time IS NOT NULL;
