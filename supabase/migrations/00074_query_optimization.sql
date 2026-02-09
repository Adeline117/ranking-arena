-- Migration: Query Optimization & Indexing
-- Date: 2026-02-08
-- Purpose: Add missing indexes for common query patterns identified in API routes
--
-- Analysis of heavy queries:
--   1. /api/rankings - trader_snapshots: filter by season_id/source, sort by arena_score/roi/pnl
--   2. /api/v2/rankings - trader_snapshots: filter by source+market_type+window, sort by various metrics
--   3. /api/posts - posts: sort by hot_score, created_at, filter by group_id/author
--   4. /api/flash-news - flash_news: sort by published_at, filter by category/importance
--   5. /api/library - library_items: filter by category, sort by created_at/view_count/rating
--   6. /api/traders - leaderboard_ranks: filter by season_id+source, sort by rank
--   7. /api/sidebar/top-traders - trader_snapshots + trader_sources join
--   8. /api/cron/backfill-avatars - trader_sources: filter by source WHERE avatar_url IS NULL
--
-- Note: Using IF NOT EXISTS to be idempotent. Not using CONCURRENTLY since
-- Supabase migrations run in a transaction context.

-- ============================================================
-- 1. trader_snapshots - Rankings queries (highest traffic)
-- ============================================================

-- V1 rankings: filter season_id + sort by arena_score (with ROI bounds)
CREATE INDEX IF NOT EXISTS idx_trader_snapshots_season_arena
  ON trader_snapshots(season_id, arena_score DESC NULLS LAST)
  WHERE arena_score IS NOT NULL;

-- V2 rankings: composite for source+market_type+window pattern
CREATE INDEX IF NOT EXISTS idx_trader_snapshots_v2_ranking
  ON trader_snapshots(source, market_type, window, arena_score DESC NULLS LAST)
  WHERE arena_score IS NOT NULL;

-- V2 rankings: ROI sort variant
CREATE INDEX IF NOT EXISTS idx_trader_snapshots_v2_roi
  ON trader_snapshots(source, market_type, window, roi DESC NULLS LAST);

-- V2 rankings: PNL sort variant
CREATE INDEX IF NOT EXISTS idx_trader_snapshots_v2_pnl
  ON trader_snapshots(source, market_type, window, pnl DESC NULLS LAST);

-- Sidebar top-traders: season_id=90D, arena_score > 0, order by arena_score
CREATE INDEX IF NOT EXISTS idx_trader_snapshots_top_traders
  ON trader_snapshots(season_id, arena_score DESC NULLS LAST)
  WHERE arena_score IS NOT NULL AND arena_score > 0;

-- Snapshot lookup by trader for deduplication and joins
CREATE INDEX IF NOT EXISTS idx_trader_snapshots_trader_lookup
  ON trader_snapshots(source, source_trader_id, captured_at DESC);

-- ============================================================
-- 2. trader_sources - Join target for rankings + avatar backfill
-- ============================================================

-- Rankings join: lookup by (source, source_trader_id) for handle/avatar
CREATE INDEX IF NOT EXISTS idx_trader_sources_source_trader
  ON trader_sources(source, source_trader_id);

-- Avatar backfill: find traders missing avatars per platform
CREATE INDEX IF NOT EXISTS idx_trader_sources_missing_avatar
  ON trader_sources(source)
  WHERE avatar_url IS NULL;

-- Active trader sources for sidebar queries
CREATE INDEX IF NOT EXISTS idx_trader_sources_active_source_trader
  ON trader_sources(source, source_trader_id)
  WHERE is_active = true;

-- ============================================================
-- 3. posts - Hot discussions & feed queries
-- ============================================================

-- Like count sort (existing idx_posts_like_count may not have created_at)
CREATE INDEX IF NOT EXISTS idx_posts_like_count_desc
  ON posts(like_count DESC NULLS LAST, created_at DESC);

-- ============================================================
-- 4. flash_news - Timeline queries
-- ============================================================

-- Composite for category + time sort
CREATE INDEX IF NOT EXISTS idx_flash_news_category_published
  ON flash_news(category, published_at DESC);

-- Composite for importance + time sort
CREATE INDEX IF NOT EXISTS idx_flash_news_importance_published
  ON flash_news(importance, published_at DESC);

-- ============================================================
-- 5. library_items - Library browsing
-- ============================================================

-- Category + created_at for default "recent" sort
CREATE INDEX IF NOT EXISTS idx_library_items_cat_created
  ON library_items(category, created_at DESC);

-- Category + view_count for "popular" sort
CREATE INDEX IF NOT EXISTS idx_library_items_cat_views
  ON library_items(category, view_count DESC NULLS LAST);

-- Category + rating for "rating" sort
CREATE INDEX IF NOT EXISTS idx_library_items_cat_rating
  ON library_items(category, rating DESC NULLS LAST);

-- ============================================================
-- 6. leaderboard_ranks - Pre-computed rankings
-- ============================================================

-- Main query: season_id + optional source + order by rank
CREATE INDEX IF NOT EXISTS idx_leaderboard_ranks_season_source_rank
  ON leaderboard_ranks(season_id, source, rank ASC);

-- Distinct sources query (for filter dropdown)
CREATE INDEX IF NOT EXISTS idx_leaderboard_ranks_source
  ON leaderboard_ranks(source);

-- ============================================================
-- Notes
-- ============================================================
-- RLS Performance: Most read queries use service_role (bypasses RLS).
-- Public-read tables (posts, flash_news, library_items) have minimal RLS overhead.
--
-- N+1 Patterns: All API routes batch lookups with .in() filters. No N+1 issues found.
-- The backfill-avatars cron does sequential updates by design (rate-limited API calls).
--
-- Query Timeouts: Supabase managed has default statement_timeout.
-- App-level timeouts exist via withTimeout() wrapper in trader detail API.
