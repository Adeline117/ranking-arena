-- Arena Database Missing Indexes
-- Generated: 2026-02-13
-- Purpose: Optimize query performance based on API route analysis
-- Safety: CREATE INDEX IF NOT EXISTS - won't affect existing indexes

-- ============================================================
-- 1. leaderboard_ranks - is_outlier filter (used in /api/traders)
--    Query: .eq('season_id', X).or('is_outlier.is.null,is_outlier.eq.false')
--    Missing: partial index for non-outlier rows
-- ============================================================
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_leaderboard_ranks_season_not_outlier
  ON public.leaderboard_ranks (season_id, rank)
  WHERE (is_outlier IS NULL OR is_outlier = false);

-- ============================================================
-- 2. leaderboard_ranks - season + source + rank (sidebar top-traders)
--    Query: .eq('season_id', '90D').order('rank', ascending: true)
-- ============================================================
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_leaderboard_ranks_season_source_rank
  ON public.leaderboard_ranks (season_id, source, rank);

-- ============================================================
-- 3. posts - status filter for trending sidebar
--    Query: .eq('status', 'active').order('hot_score', desc)
-- ============================================================
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_posts_status_hot_score
  ON public.posts (status, hot_score DESC NULLS LAST)
  WHERE (deleted_at IS NULL);

-- ============================================================
-- 4. posts - group_id + created_at (already exists but adding hot_score variant)
--    Query: .eq('group_id', X).order('hot_score', desc)
-- ============================================================
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_posts_group_hot_score
  ON public.posts (group_id, hot_score DESC NULLS LAST)
  WHERE (deleted_at IS NULL);

-- ============================================================
-- 5. posts - bookmark_count sort
--    Query: .order('bookmark_count', desc) - used in bookmarked posts
-- ============================================================
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_posts_bookmark_count
  ON public.posts (bookmark_count DESC NULLS LAST)
  WHERE (bookmark_count > 0);

-- ============================================================
-- 6. post_bookmarks - user_id lookup (for bookmark status check)
--    Query: .from('post_bookmarks').select().in('post_id', postIds).eq('user_id', X)
-- ============================================================
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_post_bookmarks_user_id
  ON public.post_bookmarks (user_id);

-- ============================================================
-- 7. post_likes - user_id + post_id for batch reaction lookups
--    Query: .from('post_likes').select().in('post_id', postIds).eq('user_id', X)
--    Existing: post_id+user_id unique. Adding user_id leading for user-first queries.
-- ============================================================
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_post_likes_user_post
  ON public.post_likes (user_id, post_id);

-- ============================================================
-- 8. post_votes - user_id + post_id for batch vote lookups
--    Query: .from('post_votes').select().in('post_id', postIds).eq('user_id', X)
--    Existing: post_id+user_id unique. Adding user_id leading index.
-- ============================================================
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_post_votes_user_post
  ON public.post_votes (user_id, post_id);

-- ============================================================
-- 9. notifications - type filter
--    Query: .eq('user_id', X).eq('type', Y).order('created_at', desc)
-- ============================================================
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_notifications_user_type
  ON public.notifications (user_id, type, created_at DESC);

-- ============================================================
-- 10. trader_snapshots - source + source_trader_id + season_id lookup
--     Query: .eq('source', X).eq('source_trader_id', Y).eq('season_id', Z)
--     Already has uq_trader_snapshots_source_trader_season unique index - OK
--     But also needs: source + source_trader_id for profile page (multiple seasons)
-- ============================================================
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_trader_snapshots_source_trader
  ON public.trader_snapshots (source, source_trader_id);

-- ============================================================
-- 11. trader_snapshots - season_id + source for leaderboard filtering
--     Query: .eq('season_id', X).eq('source', Y).order('arena_score', desc)
--     Existing idx_trader_snapshots_arena_score covers (source, season_id, arena_score)
--     But adding season_id leading for season-first queries
-- ============================================================
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_trader_snapshots_season_source_score
  ON public.trader_snapshots (season_id, source, arena_score DESC NULLS LAST)
  WHERE (arena_score IS NOT NULL);

-- ============================================================
-- 12. user_follows - follower_id + following_id composite for mutual check
--     Already has unique constraint - OK
--     But adding following_id leading for "who follows this user" queries
-- ============================================================
-- Already covered by idx_user_follows_following - SKIP

-- ============================================================
-- 13. trader_portfolio - source + source_trader_id + captured_at
--     Query: .eq('source_trader_id', X).order('captured_at', desc)
--     Existing idx covers (source, source_trader_id) - good
-- ============================================================
-- Already covered - SKIP

-- ============================================================
-- 14. library_items - created_at DESC for default sort
--     Query: .from('library_items').order('created_at', desc)
-- ============================================================
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_library_items_created_at
  ON public.library_items (created_at DESC);

-- ============================================================
-- 15. saved_filters - user_id lookup
--     Query: .from('saved_filters').eq('user_id', X)
-- ============================================================
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_saved_filters_user_id
  ON public.saved_filters (user_id);

-- ============================================================
-- 16. trader_alerts - user_id + is_active for active alerts
--     Query: .from('trader_alerts').eq('user_id', X)
-- ============================================================
-- Already has idx_trader_alerts_user - SKIP

-- ============================================================
-- 17. direct_messages - conversation_id + created_at for chat search
--     Already has idx_dm_created - SKIP
-- ============================================================

-- ============================================================
-- 18. login_sessions - session_token lookup
--     Query: .from('login_sessions').eq('session_token', X)
-- ============================================================
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_login_sessions_token
  ON public.login_sessions (session_token)
  WHERE (revoked = false);
