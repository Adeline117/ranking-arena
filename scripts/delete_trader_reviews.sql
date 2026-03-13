-- Delete trader_reviews and review_likes tables
-- Run this manually against the production database after confirming

-- Drop constraint from data_integrity_constraints migration
ALTER TABLE trader_reviews DROP CONSTRAINT IF EXISTS chk_trader_reviews_rating;

-- Drop RLS policies
DROP POLICY IF EXISTS "Anyone can read reviews" ON trader_reviews;
DROP POLICY IF EXISTS "Authenticated users can create reviews" ON trader_reviews;
DROP POLICY IF EXISTS "Users can update own reviews" ON trader_reviews;
DROP POLICY IF EXISTS "Users can delete own reviews" ON trader_reviews;
DROP POLICY IF EXISTS "Anyone can read review likes" ON review_likes;
DROP POLICY IF EXISTS "Authenticated users can like reviews" ON review_likes;
DROP POLICY IF EXISTS "Users can unlike own likes" ON review_likes;

-- Drop indexes
DROP INDEX IF EXISTS idx_trader_reviews_trader_id;
DROP INDEX IF EXISTS idx_trader_reviews_user_id;
DROP INDEX IF EXISTS idx_trader_reviews_created_at;
DROP INDEX IF EXISTS idx_trader_reviews_rating;
DROP INDEX IF EXISTS idx_review_likes_review_id;
DROP INDEX IF EXISTS idx_review_likes_user_id;

-- Drop tables (review_likes first due to FK dependency)
DROP TABLE IF EXISTS review_likes;
DROP TABLE IF EXISTS trader_reviews;
