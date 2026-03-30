-- Composite index on trader_snapshots_v2 for leaderboard queries
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_trader_snapshots_v2_platform_window_score
ON trader_snapshots_v2 (platform, window, arena_score DESC);

-- Index on trader_position_history for per-symbol position lookups
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_trader_position_history_symbol
ON trader_position_history (source, source_trader_id, symbol, closed_at DESC);

-- Add NOT NULL defaults to commonly-accessed columns on trader_snapshots_v2
ALTER TABLE trader_snapshots_v2 ALTER COLUMN followers SET DEFAULT 0;
ALTER TABLE trader_snapshots_v2 ALTER COLUMN trades_count SET DEFAULT 0;
ALTER TABLE trader_snapshots_v2 ALTER COLUMN metrics SET DEFAULT '{}'::jsonb;
