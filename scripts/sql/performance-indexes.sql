-- Arena Database Performance Indexes
-- Generated: 2026-02-13
-- Purpose: Optimize hot-path API query performance
-- Safety: All use IF NOT EXISTS + CONCURRENTLY (no locks on production)

-- ============================================================
-- RANKINGS API (/api/rankings)
-- Main query: trader_snapshots WHERE season_id = X AND arena_score IS NOT NULL
--   ORDER BY arena_score/roi/pnl/max_drawdown DESC
--   WITH filters: source, roi range, trades_count
-- ============================================================

-- Primary rankings index: season + source + arena_score (covers most queries)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ts_season_source_arena_score
  ON public.trader_snapshots (season_id, source, arena_score DESC NULLS LAST)
  WHERE (arena_score IS NOT NULL);

-- Rankings sorted by ROI
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ts_season_source_roi
  ON public.trader_snapshots (season_id, source, roi DESC NULLS LAST)
  WHERE (arena_score IS NOT NULL);

-- Rankings sorted by PNL
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ts_season_source_pnl
  ON public.trader_snapshots (season_id, source, pnl DESC NULLS LAST)
  WHERE (arena_score IS NOT NULL);

-- Freshness check: latest captured_at per season (used for staleness detection)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ts_season_captured_at
  ON public.trader_snapshots (season_id, captured_at DESC)
  WHERE (arena_score IS NOT NULL);

-- Display name lookup: trader_sources by source + source_trader_id
-- (batch lookup for ranking rows)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_trader_sources_source_trader_id
  ON public.trader_sources (source, source_trader_id);

-- ============================================================
-- SEARCH API (/api/search)
-- ILIKE queries on: trader_sources.handle, posts.title,
--   library_items.title/author, user_profiles.handle/display_name
-- Note: ILIKE %x% cannot use btree. Use pg_trgm GIN for acceleration.
-- ============================================================

-- Enable pg_trgm extension (idempotent)
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Trader search by handle
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_trader_sources_handle_trgm
  ON public.trader_sources USING gin (handle gin_trgm_ops);

-- Trader search by source_trader_id
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_trader_sources_trader_id_trgm
  ON public.trader_sources USING gin (source_trader_id gin_trgm_ops);

-- Post search by title
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_posts_title_trgm
  ON public.posts USING gin (title gin_trgm_ops);

-- Library search by title
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_library_items_title_trgm
  ON public.library_items USING gin (title gin_trgm_ops);

-- Library search by author
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_library_items_author_trgm
  ON public.library_items USING gin (author gin_trgm_ops);

-- User search by handle
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_user_profiles_handle_trgm
  ON public.user_profiles USING gin (handle gin_trgm_ops);

-- User search by display_name
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_user_profiles_display_name_trgm
  ON public.user_profiles USING gin (display_name gin_trgm_ops);

-- ============================================================
-- FLASH NEWS API (/api/flash-news)
-- Query: flash_news WHERE category = X AND importance = Y
--   ORDER BY published_at DESC, with LIMIT/OFFSET pagination
-- ============================================================

-- Primary flash news listing index
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_flash_news_published_at
  ON public.flash_news (published_at DESC);

-- Category + published_at for filtered queries
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_flash_news_category_published
  ON public.flash_news (category, published_at DESC);

-- Importance + published_at for importance-filtered queries
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_flash_news_importance_published
  ON public.flash_news (importance, published_at DESC);

-- ============================================================
-- TRADER DETAIL API (/api/trader/by-id/[id])
-- Raw SQL queries against: trader_sources_v2, trader_profiles_v2,
--   trader_snapshots_v2, trader_timeseries
-- ============================================================

-- trader_sources_v2: lookup by platform + trader_key
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_trader_sources_v2_platform_key
  ON public.trader_sources_v2 (platform, trader_key);

-- trader_profiles_v2: lookup by platform + trader_key
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_trader_profiles_v2_platform_key
  ON public.trader_profiles_v2 (platform, trader_key);

-- trader_snapshots_v2: lookup by platform + trader_key + window
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_trader_snapshots_v2_platform_key_window
  ON public.trader_snapshots_v2 (platform, trader_key, "window");

-- trader_timeseries: lookup by platform + trader_key, ordered by as_of_ts
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_trader_timeseries_platform_key_ts
  ON public.trader_timeseries (platform, trader_key, as_of_ts DESC);

-- ============================================================
-- POSTS API (/api/posts)
-- Query: posts ORDER BY created_at/hot_score/like_count DESC
--   WITH filters: group_id, author_id, author_handle
-- ============================================================

-- Posts sorted by hot_score (most common sort for feed)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_posts_hot_score
  ON public.posts (hot_score DESC NULLS LAST);

-- Posts by group + hot_score
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_posts_group_hot_score
  ON public.posts (group_id, hot_score DESC NULLS LAST);

-- Posts by group + created_at
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_posts_group_created_at
  ON public.posts (group_id, created_at DESC);

-- Posts by author_id + created_at
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_posts_author_created_at
  ON public.posts (author_id, created_at DESC);

-- Posts by author_handle (fallback lookup)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_posts_author_handle
  ON public.posts (author_handle);

-- Post view_count for search result ordering
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_posts_view_count
  ON public.posts (view_count DESC NULLS LAST);

-- ============================================================
-- SUPPORTING TABLES (from existing add-missing-indexes.sql, deduplicated)
-- ============================================================

-- post_bookmarks: user lookup
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_post_bookmarks_user_id
  ON public.post_bookmarks (user_id);

-- post_likes: user-first lookup for batch reactions
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_post_likes_user_post
  ON public.post_likes (user_id, post_id);

-- post_votes: user-first lookup for batch votes
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_post_votes_user_post
  ON public.post_votes (user_id, post_id);

-- notifications: user + type + time
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_notifications_user_type
  ON public.notifications (user_id, type, created_at DESC);

-- user_profiles: handle lookup (for author_handle → author_id resolution)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_user_profiles_handle
  ON public.user_profiles (handle);

-- user_profiles: user_id lookup
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_user_profiles_user_id
  ON public.user_profiles (user_id);

-- library_items: created_at for default sort
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_library_items_created_at
  ON public.library_items (created_at DESC);

-- saved_filters: user lookup
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_saved_filters_user_id
  ON public.saved_filters (user_id);

-- search_analytics: for the async insert (no read-path index needed, just ensure insert is fast)
-- No index needed - append-only table

-- leaderboard_ranks: season + non-outlier partial index
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_leaderboard_ranks_season_not_outlier
  ON public.leaderboard_ranks (season_id, rank)
  WHERE (is_outlier IS NULL OR is_outlier = false);

-- login_sessions: token lookup
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_login_sessions_token
  ON public.login_sessions (session_token)
  WHERE (revoked = false);
