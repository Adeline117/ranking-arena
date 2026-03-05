-- Data Integrity Constraints Migration
-- Adds CHECK constraints to enforce data quality at the database level

-- ============================================
-- trader_sources: Percentage constraints
-- ============================================

-- win_rate should be between 0 and 100 (or NULL)
ALTER TABLE trader_sources
ADD CONSTRAINT chk_trader_sources_win_rate
CHECK (win_rate IS NULL OR (win_rate >= 0 AND win_rate <= 100));

-- profit_sharing should be between 0 and 100 (or NULL)
ALTER TABLE trader_sources
ADD CONSTRAINT chk_trader_sources_profit_sharing
CHECK (profit_sharing IS NULL OR (profit_sharing >= 0 AND profit_sharing <= 100));

-- followers should be non-negative (or NULL)
ALTER TABLE trader_sources
ADD CONSTRAINT chk_trader_sources_followers
CHECK (followers IS NULL OR followers >= 0);

-- aum should be non-negative (or NULL)
ALTER TABLE trader_sources
ADD CONSTRAINT chk_trader_sources_aum
CHECK (aum IS NULL OR aum >= 0);

-- ============================================
-- trader_daily_snapshots: Percentage constraints
-- ============================================

-- win_rate should be between 0 and 100 (or NULL)
ALTER TABLE trader_daily_snapshots
ADD CONSTRAINT chk_trader_daily_snapshots_win_rate
CHECK (win_rate IS NULL OR (win_rate >= 0 AND win_rate <= 100));

-- mdd (max drawdown) should be between -100 and 0 (or NULL)
-- Note: MDD is typically negative or zero
ALTER TABLE trader_daily_snapshots
ADD CONSTRAINT chk_trader_daily_snapshots_mdd
CHECK (mdd IS NULL OR (mdd >= -100 AND mdd <= 0));

-- followers should be non-negative (or NULL)
ALTER TABLE trader_daily_snapshots
ADD CONSTRAINT chk_trader_daily_snapshots_followers
CHECK (followers IS NULL OR followers >= 0);

-- ============================================
-- leaderboard_ranks: Percentage constraints
-- ============================================

-- win_rate should be between 0 and 100 (or NULL)
ALTER TABLE leaderboard_ranks
ADD CONSTRAINT chk_leaderboard_ranks_win_rate
CHECK (win_rate IS NULL OR (win_rate >= 0 AND win_rate <= 100));

-- mdd (max drawdown) should be between -100 and 0 (or NULL)
ALTER TABLE leaderboard_ranks
ADD CONSTRAINT chk_leaderboard_ranks_mdd
CHECK (mdd IS NULL OR (mdd >= -100 AND mdd <= 0));

-- follower_count should be non-negative (or NULL)
ALTER TABLE leaderboard_ranks
ADD CONSTRAINT chk_leaderboard_ranks_follower_count
CHECK (follower_count IS NULL OR follower_count >= 0);

-- aum should be non-negative (or NULL)
ALTER TABLE leaderboard_ranks
ADD CONSTRAINT chk_leaderboard_ranks_aum
CHECK (aum IS NULL OR aum >= 0);

-- rank should be positive (or NULL)
ALTER TABLE leaderboard_ranks
ADD CONSTRAINT chk_leaderboard_ranks_rank
CHECK (rank IS NULL OR rank > 0);

-- ============================================
-- user_profiles: Positive counters
-- ============================================

-- follower_count should be non-negative
ALTER TABLE user_profiles
ADD CONSTRAINT chk_user_profiles_follower_count
CHECK (follower_count IS NULL OR follower_count >= 0);

-- following_count should be non-negative
ALTER TABLE user_profiles
ADD CONSTRAINT chk_user_profiles_following_count
CHECK (following_count IS NULL OR following_count >= 0);

-- ============================================
-- posts: Non-negative counters
-- ============================================

-- like_count should be non-negative
ALTER TABLE posts
ADD CONSTRAINT chk_posts_like_count
CHECK (like_count IS NULL OR like_count >= 0);

-- comment_count should be non-negative
ALTER TABLE posts
ADD CONSTRAINT chk_posts_comment_count
CHECK (comment_count IS NULL OR comment_count >= 0);

-- view_count should be non-negative
ALTER TABLE posts
ADD CONSTRAINT chk_posts_view_count
CHECK (view_count IS NULL OR view_count >= 0);

-- ============================================
-- library_books: Valid page counts and ratings
-- ============================================

-- page_count should be positive (or NULL)
ALTER TABLE library_books
ADD CONSTRAINT chk_library_books_page_count
CHECK (page_count IS NULL OR page_count > 0);

-- average_rating should be between 0 and 5 (or NULL)
ALTER TABLE library_books
ADD CONSTRAINT chk_library_books_average_rating
CHECK (average_rating IS NULL OR (average_rating >= 0 AND average_rating <= 5));

-- rating_count should be non-negative (or NULL)
ALTER TABLE library_books
ADD CONSTRAINT chk_library_books_rating_count
CHECK (rating_count IS NULL OR rating_count >= 0);

-- ============================================
-- book_reviews: Valid rating range
-- ============================================

-- rating should be between 1 and 5
ALTER TABLE book_reviews
ADD CONSTRAINT chk_book_reviews_rating
CHECK (rating >= 1 AND rating <= 5);

-- ============================================
-- trader_reviews: Valid rating range
-- ============================================

-- rating should be between 1 and 5
ALTER TABLE trader_reviews
ADD CONSTRAINT chk_trader_reviews_rating
CHECK (rating >= 1 AND rating <= 5);

-- ============================================
-- Comments for documentation
-- ============================================

COMMENT ON CONSTRAINT chk_trader_sources_win_rate ON trader_sources IS 'Win rate must be between 0-100%';
COMMENT ON CONSTRAINT chk_trader_sources_profit_sharing ON trader_sources IS 'Profit sharing must be between 0-100%';
COMMENT ON CONSTRAINT chk_trader_sources_followers ON trader_sources IS 'Follower count must be non-negative';
COMMENT ON CONSTRAINT chk_trader_sources_aum ON trader_sources IS 'AUM must be non-negative';
