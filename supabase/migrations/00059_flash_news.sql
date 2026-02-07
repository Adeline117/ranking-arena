-- Flash News / Newsfeed 快讯功能
-- 时间线形式的实时快讯，覆盖加密货币、宏观经济、金融市场动态

CREATE TABLE IF NOT EXISTS flash_news (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  title_zh TEXT,
  title_en TEXT,
  content TEXT,
  source TEXT NOT NULL,
  source_url TEXT,
  category TEXT DEFAULT 'crypto' CHECK (category IN ('crypto', 'macro', 'defi', 'regulation', 'market')),
  importance TEXT DEFAULT 'normal' CHECK (importance IN ('breaking', 'important', 'normal')),
  tags TEXT[],
  published_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 索引优化
CREATE INDEX idx_flash_news_published ON flash_news(published_at DESC);
CREATE INDEX idx_flash_news_category ON flash_news(category);
CREATE INDEX idx_flash_news_importance ON flash_news(importance);

-- RLS 政策
ALTER TABLE flash_news ENABLE ROW LEVEL SECURITY;

-- 所有用户都可以读取快讯
CREATE POLICY "Anyone can view flash news"
  ON flash_news
  FOR SELECT
  USING (true);

-- 只有管理员可以插入/更新/删除快讯
CREATE POLICY "Only admins can manage flash news"
  ON flash_news
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles 
      WHERE user_profiles.user_id = auth.uid() 
      AND user_profiles.role = 'admin'
    )
  );

-- 为快讯添加一些示例数据
INSERT INTO flash_news (title, title_zh, title_en, content, source, source_url, category, importance, tags, published_at) VALUES 
('Bitcoin突破$100,000大关', 'Bitcoin突破$100,000大关', 'Bitcoin Breaks $100,000 Milestone', 'Bitcoin价格首次突破$100,000，创历史新高，市场情绪高涨。', 'CoinDesk', 'https://coindesk.com', 'crypto', 'breaking', ARRAY['bitcoin', 'price', 'milestone'], NOW() - INTERVAL '1 hour'),
('美联储会议纪要公布', '美联储会议纪要公布', 'Fed Meeting Minutes Released', '最新的美联储会议纪要显示对通胀的持续关注。', 'Reuters', 'https://reuters.com', 'macro', 'important', ARRAY['fed', 'inflation', 'policy'], NOW() - INTERVAL '2 hours'),
('以太坊Layer2总锁仓价值创新高', '以太坊Layer2总锁仓价值创新高', 'Ethereum L2 TVL Hits New Record', 'Polygon、Arbitrum等Layer2解决方案总锁仓价值突破新纪录。', 'The Block', 'https://theblock.co', 'defi', 'normal', ARRAY['ethereum', 'layer2', 'defi'], NOW() - INTERVAL '3 hours'),
('SEC考虑放宽加密货币监管', 'SEC考虑放宽加密货币监管', 'SEC Considers Relaxing Crypto Regulations', '美国证券交易委员会正在考虑对加密货币采取更宽松的监管态度。', 'CoinTelegraph', 'https://cointelegraph.com', 'regulation', 'important', ARRAY['sec', 'regulation', 'policy'], NOW() - INTERVAL '4 hours');