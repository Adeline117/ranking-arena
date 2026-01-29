-- 交易员评价表
CREATE TABLE IF NOT EXISTS trader_reviews (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  trader_id TEXT NOT NULL,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
  content TEXT NOT NULL CHECK (char_length(content) <= 2000),
  like_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  -- 每个用户只能对同一交易员评价一次
  CONSTRAINT trader_reviews_unique_user_trader UNIQUE (trader_id, user_id)
);

-- 评价点赞表
CREATE TABLE IF NOT EXISTS review_likes (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  review_id UUID NOT NULL REFERENCES trader_reviews(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT review_likes_unique UNIQUE (review_id, user_id)
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_trader_reviews_trader_id ON trader_reviews(trader_id);
CREATE INDEX IF NOT EXISTS idx_trader_reviews_user_id ON trader_reviews(user_id);
CREATE INDEX IF NOT EXISTS idx_trader_reviews_created_at ON trader_reviews(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_trader_reviews_rating ON trader_reviews(trader_id, rating);
CREATE INDEX IF NOT EXISTS idx_review_likes_review_id ON review_likes(review_id);
CREATE INDEX IF NOT EXISTS idx_review_likes_user_id ON review_likes(user_id);

-- RLS 策略
ALTER TABLE trader_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE review_likes ENABLE ROW LEVEL SECURITY;

-- 所有人可读评价
CREATE POLICY "Anyone can read reviews"
  ON trader_reviews FOR SELECT
  USING (true);

-- 登录用户可创建评价
CREATE POLICY "Authenticated users can create reviews"
  ON trader_reviews FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- 用户只能更新自己的评价
CREATE POLICY "Users can update own reviews"
  ON trader_reviews FOR UPDATE
  USING (auth.uid() = user_id);

-- 用户只能删除自己的评价
CREATE POLICY "Users can delete own reviews"
  ON trader_reviews FOR DELETE
  USING (auth.uid() = user_id);

-- 所有人可读点赞
CREATE POLICY "Anyone can read review likes"
  ON review_likes FOR SELECT
  USING (true);

-- 登录用户可点赞
CREATE POLICY "Authenticated users can like reviews"
  ON review_likes FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- 用户只能取消自己的点赞
CREATE POLICY "Users can unlike own likes"
  ON review_likes FOR DELETE
  USING (auth.uid() = user_id);
