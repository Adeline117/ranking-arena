-- Fix leaderboard_ranks table bloat (914K dead rows, 37.8x dead ratio)
-- Root cause: compute-leaderboard generates massive churn, default autovacuum can't keep up

-- 1. Aggressive autovacuum settings for high-churn tables
ALTER TABLE leaderboard_ranks SET (
  autovacuum_vacuum_scale_factor = 0.01,    -- trigger at 1% dead (was 20%)
  autovacuum_vacuum_threshold = 100,         -- minimum dead rows to trigger
  autovacuum_vacuum_cost_delay = 2,          -- faster vacuum (default 20ms)
  autovacuum_analyze_scale_factor = 0.02     -- re-analyze more frequently
);

ALTER TABLE trader_snapshots_v2 SET (
  autovacuum_vacuum_scale_factor = 0.02,
  autovacuum_vacuum_threshold = 100,
  autovacuum_vacuum_cost_delay = 2,
  autovacuum_analyze_scale_factor = 0.05
);

-- 2. Add missing index on computed_at (health check query was doing full table scan)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_leaderboard_ranks_computed_at
  ON leaderboard_ranks (computed_at DESC);
