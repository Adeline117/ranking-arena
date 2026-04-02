-- Performance audit: add missing indexes, drop unused indexes
-- Audit date: 2026-04-02

-- ============================================================
-- 1. trader_position_history: pkey (2 GB) has only 7 scans
--    The unique constraint uq_position_history_source_trader_symbol_opentime
--    handles dedup. The serial `id` pkey is dead weight.
--    ACTION: Cannot drop pkey without schema change. Flag for future.
-- ============================================================

-- ============================================================
-- 2. trader_portfolio: pkey (65 MB) has 0 scans
--    Same pattern - serial `id` pkey never used for lookups.
--    The idx_trader_portfolio_captured (21 MB) handles all queries.
--    ACTION: Flag for future schema refactor (use composite PK).
-- ============================================================

-- ============================================================
-- 3. Drop confirmed unused indexes (small, safe)
-- ============================================================

-- idx_traders_active: 2.5 MB, 0 scans
DROP INDEX CONCURRENTLY IF EXISTS idx_traders_active;

-- idx_library_items_author_trgm: 7 MB, 0 scans (trigram on author - never searched)
DROP INDEX CONCURRENTLY IF EXISTS idx_library_items_author_trgm;

-- idx_library_tags: 896 kB, 0 scans
DROP INDEX CONCURRENTLY IF EXISTS idx_library_tags;

-- idx_library_source: 408 kB, 0 scans
DROP INDEX CONCURRENTLY IF EXISTS idx_library_source;

-- Various posts indexes with 0 scans (social is secondary feature)
DROP INDEX CONCURRENTLY IF EXISTS idx_posts_group_created;
DROP INDEX CONCURRENTLY IF EXISTS idx_posts_feed;
DROP INDEX CONCURRENTLY IF EXISTS idx_posts_created_at;
DROP INDEX CONCURRENTLY IF EXISTS idx_posts_status_hot_score;

-- flash_news indexes with 0 scans
DROP INDEX CONCURRENTLY IF EXISTS idx_flash_news_importance_published;
DROP INDEX CONCURRENTLY IF EXISTS idx_flash_news_category_published;

-- trader_sources_v2 unused index
DROP INDEX CONCURRENTLY IF EXISTS idx_trader_sources_v2_active;

-- Old partition indexes: cannot drop individually (inherited from parent).
-- These will be cleaned up when old partitions are detached.

-- ============================================================
-- 4. Add missing indexes for high-seq-scan tables
-- ============================================================

-- subscriptions: 6,771 seq scans, 0 idx scans despite having indexes
-- Add a status-filtered index for active subscription lookups
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_subscriptions_status
  ON subscriptions (status) WHERE status = 'active';

-- strategies: 4,665 seq scans, 1 idx scan - needs trader_id index
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_strategies_trader_id
  ON strategies (trader_id);

-- signals: 4,664 seq scans, pkey only - needs trader_id index
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_signals_trader_created
  ON signals (trader_id, created_at DESC);
