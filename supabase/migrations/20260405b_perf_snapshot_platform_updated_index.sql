-- Performance: add (platform, updated_at DESC) index to active partitions
-- Fixes per-platform freshness lookups: 1.3s → ~2ms
-- Health check snapshot queries: 25M ms total → ~50ms total

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_snap_v2_p2026_04_platform_updated
ON trader_snapshots_v2_p2026_04 (platform, updated_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_snap_v2_p2026_03_platform_updated
ON trader_snapshots_v2_p2026_03 (platform, updated_at DESC);
