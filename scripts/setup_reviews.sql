-- ============================================
-- 用户评价系统数据库表
-- 用于存储用户对交易员的评价和口碑数据
-- ============================================

-- 交易员评价表
CREATE TABLE IF NOT EXISTS trader_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trader_id TEXT NOT NULL,           -- 交易员 ID
  source TEXT NOT NULL,              -- 来源交易所
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  
  -- 评分维度 (1-5 星)
  overall_rating INTEGER NOT NULL CHECK (overall_rating BETWEEN 1 AND 5),
  stability_rating INTEGER CHECK (stability_rating BETWEEN 1 AND 5),  -- 稳定性
  drawdown_rating INTEGER CHECK (drawdown_rating BETWEEN 1 AND 5),   -- 回撤控制
  
  -- 跟单体验
  review_text TEXT,
  follow_duration_days INTEGER,      -- 跟单了多久
  profit_loss_percent NUMERIC,       -- 跟单盈亏 (%)
  would_recommend BOOLEAN,           -- 是否推荐
  
  -- 验证
  screenshot_url TEXT,               -- 跟单截图证明
  verified BOOLEAN DEFAULT FALSE,    -- 是否已验证
  
  -- 互动数据
  helpful_count INTEGER DEFAULT 0,   -- 有帮助票数
  unhelpful_count INTEGER DEFAULT 0, -- 无帮助票数
  
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  
  -- 每个用户对每个交易员只能评价一次
  UNIQUE(trader_id, source, user_id)
);

-- 评价投票表（记录谁投了谁的评价）
CREATE TABLE IF NOT EXISTS review_votes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id UUID REFERENCES trader_reviews(id) ON DELETE CASCADE,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  vote_type TEXT NOT NULL CHECK (vote_type IN ('helpful', 'unhelpful')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  
  UNIQUE(review_id, user_id)
);

-- ============================================
-- 索引优化
-- ============================================

-- 按交易员查询评价
CREATE INDEX IF NOT EXISTS idx_reviews_trader ON trader_reviews(trader_id, source);

-- 按用户查询评价
CREATE INDEX IF NOT EXISTS idx_reviews_user ON trader_reviews(user_id);

-- 只查询已验证的评价
CREATE INDEX IF NOT EXISTS idx_reviews_verified ON trader_reviews(verified) WHERE verified = true;

-- 按创建时间排序
CREATE INDEX IF NOT EXISTS idx_reviews_created ON trader_reviews(created_at DESC);

-- 投票查询优化
CREATE INDEX IF NOT EXISTS idx_review_votes_review ON review_votes(review_id);
CREATE INDEX IF NOT EXISTS idx_review_votes_user ON review_votes(user_id);

-- ============================================
-- 评价聚合视图
-- ============================================

CREATE OR REPLACE VIEW trader_community_scores AS
SELECT 
  trader_id,
  source,
  ROUND(AVG(overall_rating)::NUMERIC, 2) as avg_rating,
  ROUND(AVG(stability_rating)::NUMERIC, 2) as avg_stability,
  ROUND(AVG(drawdown_rating)::NUMERIC, 2) as avg_drawdown,
  COUNT(*) as review_count,
  ROUND(AVG(CASE WHEN would_recommend THEN 1 ELSE 0 END)::NUMERIC, 2) as recommend_rate,
  ROUND(AVG(follow_duration_days)::NUMERIC, 0) as avg_follow_days,
  ROUND(AVG(profit_loss_percent)::NUMERIC, 2) as avg_profit_loss,
  COUNT(CASE WHEN verified THEN 1 END) as verified_reviews
FROM trader_reviews
GROUP BY trader_id, source;

-- ============================================
-- 自动更新 updated_at 触发器
-- ============================================

CREATE OR REPLACE FUNCTION update_trader_reviews_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_trader_reviews_updated_at ON trader_reviews;
CREATE TRIGGER trg_trader_reviews_updated_at
  BEFORE UPDATE ON trader_reviews
  FOR EACH ROW
  EXECUTE FUNCTION update_trader_reviews_updated_at();

-- ============================================
-- 更新评价投票计数的触发器
-- ============================================

CREATE OR REPLACE FUNCTION update_review_vote_counts()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.vote_type = 'helpful' THEN
      UPDATE trader_reviews SET helpful_count = helpful_count + 1 WHERE id = NEW.review_id;
    ELSE
      UPDATE trader_reviews SET unhelpful_count = unhelpful_count + 1 WHERE id = NEW.review_id;
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD.vote_type = 'helpful' THEN
      UPDATE trader_reviews SET helpful_count = helpful_count - 1 WHERE id = OLD.review_id;
    ELSE
      UPDATE trader_reviews SET unhelpful_count = unhelpful_count - 1 WHERE id = OLD.review_id;
    END IF;
    RETURN OLD;
  ELSIF TG_OP = 'UPDATE' THEN
    -- 如果投票类型改变
    IF OLD.vote_type != NEW.vote_type THEN
      IF OLD.vote_type = 'helpful' THEN
        UPDATE trader_reviews SET helpful_count = helpful_count - 1, unhelpful_count = unhelpful_count + 1 WHERE id = NEW.review_id;
      ELSE
        UPDATE trader_reviews SET helpful_count = helpful_count + 1, unhelpful_count = unhelpful_count - 1 WHERE id = NEW.review_id;
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_review_vote_counts ON review_votes;
CREATE TRIGGER trg_review_vote_counts
  AFTER INSERT OR UPDATE OR DELETE ON review_votes
  FOR EACH ROW
  EXECUTE FUNCTION update_review_vote_counts();

-- ============================================
-- Row Level Security (RLS)
-- ============================================

ALTER TABLE trader_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE review_votes ENABLE ROW LEVEL SECURITY;

-- 评价表策略：所有人可读，登录用户可写自己的
DROP POLICY IF EXISTS "Reviews are viewable by everyone" ON trader_reviews;
CREATE POLICY "Reviews are viewable by everyone" ON trader_reviews
  FOR SELECT USING (true);

DROP POLICY IF EXISTS "Users can create their own reviews" ON trader_reviews;
CREATE POLICY "Users can create their own reviews" ON trader_reviews
  FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update their own reviews" ON trader_reviews;
CREATE POLICY "Users can update their own reviews" ON trader_reviews
  FOR UPDATE USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete their own reviews" ON trader_reviews;
CREATE POLICY "Users can delete their own reviews" ON trader_reviews
  FOR DELETE USING (auth.uid() = user_id);

-- 投票表策略
DROP POLICY IF EXISTS "Votes are viewable by everyone" ON review_votes;
CREATE POLICY "Votes are viewable by everyone" ON review_votes
  FOR SELECT USING (true);

DROP POLICY IF EXISTS "Users can create their own votes" ON review_votes;
CREATE POLICY "Users can create their own votes" ON review_votes
  FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update their own votes" ON review_votes;
CREATE POLICY "Users can update their own votes" ON review_votes
  FOR UPDATE USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete their own votes" ON review_votes;
CREATE POLICY "Users can delete their own votes" ON review_votes
  FOR DELETE USING (auth.uid() = user_id);
