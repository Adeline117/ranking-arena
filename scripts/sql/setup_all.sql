-- ============================================
-- 完整数据库设置脚本
-- 包含：表结构修复 + 收藏转发功能 + Mock 数据
-- 在 Supabase Dashboard 的 SQL Editor 中运行
-- ============================================

-- ============================================
-- 第一部分：修复 groups 表结构
-- ============================================

-- 添加 member_count 列
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'groups' AND column_name = 'member_count'
  ) THEN
    ALTER TABLE groups ADD COLUMN member_count INTEGER DEFAULT 0;
  END IF;
END $$;

-- 添加 avatar_url 列
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'groups' AND column_name = 'avatar_url'
  ) THEN
    ALTER TABLE groups ADD COLUMN avatar_url TEXT;
  END IF;
END $$;

-- 添加 description 列
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'groups' AND column_name = 'description'
  ) THEN
    ALTER TABLE groups ADD COLUMN description TEXT;
  END IF;
END $$;

-- 添加 description_en 列
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'groups' AND column_name = 'description_en'
  ) THEN
    ALTER TABLE groups ADD COLUMN description_en TEXT;
  END IF;
END $$;

-- 添加 name_en 列
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'groups' AND column_name = 'name_en'
  ) THEN
    ALTER TABLE groups ADD COLUMN name_en TEXT;
  END IF;
END $$;

-- 添加 created_by 列
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'groups' AND column_name = 'created_by'
  ) THEN
    ALTER TABLE groups ADD COLUMN created_by UUID REFERENCES auth.users(id);
  END IF;
END $$;

-- 添加 role_names 列 (JSONB)
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'groups' AND column_name = 'role_names'
  ) THEN
    ALTER TABLE groups ADD COLUMN role_names JSONB DEFAULT '{}';
  END IF;
END $$;

-- ============================================
-- 第二部分：posts 表添加收藏转发计数
-- ============================================

DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'posts' AND column_name = 'bookmark_count'
  ) THEN
    ALTER TABLE posts ADD COLUMN bookmark_count INTEGER DEFAULT 0;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'posts' AND column_name = 'repost_count'
  ) THEN
    ALTER TABLE posts ADD COLUMN repost_count INTEGER DEFAULT 0;
  END IF;
END $$;

-- ============================================
-- 第三部分：创建 group_members 表
-- ============================================

CREATE TABLE IF NOT EXISTS group_members (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role TEXT DEFAULT 'member',
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(group_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_group_members_group ON group_members(group_id);
CREATE INDEX IF NOT EXISTS idx_group_members_user ON group_members(user_id);

ALTER TABLE group_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Group members are viewable by everyone" ON group_members;
CREATE POLICY "Group members are viewable by everyone"
  ON group_members FOR SELECT USING (true);

DROP POLICY IF EXISTS "Users can join groups" ON group_members;
CREATE POLICY "Users can join groups"
  ON group_members FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can leave groups" ON group_members;
CREATE POLICY "Users can leave groups"
  ON group_members FOR DELETE USING (auth.uid() = user_id);

-- ============================================
-- 第四部分：创建 post_bookmarks 收藏表
-- ============================================

CREATE TABLE IF NOT EXISTS post_bookmarks (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  post_id UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(post_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_post_bookmarks_post ON post_bookmarks(post_id);
CREATE INDEX IF NOT EXISTS idx_post_bookmarks_user ON post_bookmarks(user_id);

ALTER TABLE post_bookmarks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view their own bookmarks" ON post_bookmarks;
CREATE POLICY "Users can view their own bookmarks"
  ON post_bookmarks FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert their own bookmarks" ON post_bookmarks;
CREATE POLICY "Users can insert their own bookmarks"
  ON post_bookmarks FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete their own bookmarks" ON post_bookmarks;
CREATE POLICY "Users can delete their own bookmarks"
  ON post_bookmarks FOR DELETE USING (auth.uid() = user_id);

-- ============================================
-- 第五部分：创建 reposts 转发表
-- ============================================

CREATE TABLE IF NOT EXISTS reposts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  post_id UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  comment TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(post_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_reposts_post ON reposts(post_id);
CREATE INDEX IF NOT EXISTS idx_reposts_user ON reposts(user_id);

ALTER TABLE reposts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Reposts are viewable by everyone" ON reposts;
CREATE POLICY "Reposts are viewable by everyone"
  ON reposts FOR SELECT USING (true);

DROP POLICY IF EXISTS "Users can insert their own reposts" ON reposts;
CREATE POLICY "Users can insert their own reposts"
  ON reposts FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete their own reposts" ON reposts;
CREATE POLICY "Users can delete their own reposts"
  ON reposts FOR DELETE USING (auth.uid() = user_id);

-- ============================================
-- 第六部分：触发器
-- ============================================

-- 更新小组成员数
CREATE OR REPLACE FUNCTION update_group_member_count()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE groups SET member_count = member_count + 1 WHERE id = NEW.group_id;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE groups SET member_count = GREATEST(0, member_count - 1) WHERE id = OLD.group_id;
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_group_member_change ON group_members;
CREATE TRIGGER on_group_member_change
  AFTER INSERT OR DELETE ON group_members
  FOR EACH ROW
  EXECUTE FUNCTION update_group_member_count();

-- 更新收藏计数
CREATE OR REPLACE FUNCTION update_post_bookmark_count()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE posts SET bookmark_count = bookmark_count + 1 WHERE id = NEW.post_id;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE posts SET bookmark_count = GREATEST(0, bookmark_count - 1) WHERE id = OLD.post_id;
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_post_bookmark_change ON post_bookmarks;
CREATE TRIGGER on_post_bookmark_change
  AFTER INSERT OR DELETE ON post_bookmarks
  FOR EACH ROW
  EXECUTE FUNCTION update_post_bookmark_count();

-- 更新转发计数
CREATE OR REPLACE FUNCTION update_post_repost_count()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE posts SET repost_count = repost_count + 1 WHERE id = NEW.post_id;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE posts SET repost_count = GREATEST(0, repost_count - 1) WHERE id = OLD.post_id;
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_post_repost_change ON reposts;
CREATE TRIGGER on_post_repost_change
  AFTER INSERT OR DELETE ON reposts
  FOR EACH ROW
  EXECUTE FUNCTION update_post_repost_count();

-- Groups RLS
ALTER TABLE groups ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Groups are viewable by everyone" ON groups;
CREATE POLICY "Groups are viewable by everyone"
  ON groups FOR SELECT USING (true);

-- ============================================
-- 第七部分：Mock 数据
-- ============================================

DO $$
DECLARE
  v_user_id UUID;
  v_user_handle TEXT := 'adelinewen';
  v_group1_id UUID;
  v_group2_id UUID;
  v_group3_id UUID;
  v_post1_id UUID;
  v_post2_id UUID;
  v_post3_id UUID;
  v_post4_id UUID;
  v_post5_id UUID;
  v_post6_id UUID;
  v_post7_id UUID;
  v_post8_id UUID;
BEGIN
  -- 获取用户 ID
  SELECT id INTO v_user_id FROM auth.users WHERE email = 'adelinewen1107@outlook.com';
  
  IF v_user_id IS NULL THEN
    RAISE NOTICE '未找到用户 adelinewen1107@outlook.com，跳过 Mock 数据创建';
    RETURN;
  END IF;

  -- 确保用户有 profile
  INSERT INTO user_profiles (id, handle, bio)
  VALUES (v_user_id, v_user_handle, '加密交易爱好者 | 长期主义者')
  ON CONFLICT (id) DO UPDATE SET handle = v_user_handle;

  -- 创建小组
  v_group1_id := uuid_generate_v4();
  INSERT INTO groups (id, name, name_en, description, description_en, avatar_url, member_count, created_by)
  VALUES (
    v_group1_id,
    '量化交易研究',
    'Quantitative Trading Research',
    '探讨量化交易策略、算法交易、机器学习在金融市场的应用。',
    'Discuss quantitative trading strategies and ML applications in markets.',
    'https://api.dicebear.com/7.x/shapes/svg?seed=quant',
    1,
    v_user_id
  );

  v_group2_id := uuid_generate_v4();
  INSERT INTO groups (id, name, name_en, description, description_en, avatar_url, member_count, created_by)
  VALUES (
    v_group2_id,
    'BTC 长期持有者',
    'BTC HODLers',
    '比特币长期持有者社区。分享链上数据分析和定投策略。',
    'Bitcoin long-term holders community.',
    'https://api.dicebear.com/7.x/shapes/svg?seed=btc',
    1,
    v_user_id
  );

  v_group3_id := uuid_generate_v4();
  INSERT INTO groups (id, name, name_en, description, description_en, avatar_url, member_count, created_by)
  VALUES (
    v_group3_id,
    'DeFi 挖矿讨论',
    'DeFi Farming Discussion',
    '讨论各种 DeFi 协议的流动性挖矿机会和风险评估。',
    'Discuss DeFi liquidity mining opportunities and risk assessment.',
    'https://api.dicebear.com/7.x/shapes/svg?seed=defi',
    1,
    v_user_id
  );

  -- 添加成员
  INSERT INTO group_members (group_id, user_id, role) VALUES (v_group1_id, v_user_id, 'owner') ON CONFLICT DO NOTHING;
  INSERT INTO group_members (group_id, user_id, role) VALUES (v_group2_id, v_user_id, 'owner') ON CONFLICT DO NOTHING;
  INSERT INTO group_members (group_id, user_id, role) VALUES (v_group3_id, v_user_id, 'owner') ON CONFLICT DO NOTHING;

  -- 创建帖子
  v_post1_id := uuid_generate_v4();
  INSERT INTO posts (id, group_id, author_id, author_handle, title, content, like_count, comment_count, created_at)
  VALUES (v_post1_id, v_group1_id, v_user_id, v_user_handle, '分享一个简单的均线交叉策略回测结果',
    '最近用 Python 回测了一个经典的 EMA 20/50 交叉策略。回测结果：总收益率 +156%，最大回撤 -34%，胜率 42%。大家有什么改进建议吗？',
    15, 8, NOW() - INTERVAL '2 days');

  v_post2_id := uuid_generate_v4();
  INSERT INTO posts (id, group_id, author_id, author_handle, title, content, like_count, comment_count, created_at)
  VALUES (v_post2_id, v_group1_id, v_user_id, v_user_handle, '如何用机器学习预测加密货币价格？',
    '最近在研究用 LSTM 网络预测 BTC 价格走势，但效果一般。遇到过拟合和震荡行情表现差的问题，有没有大佬有经验？',
    23, 15, NOW() - INTERVAL '1 day');

  v_post3_id := uuid_generate_v4();
  INSERT INTO posts (id, group_id, author_id, author_handle, title, content, like_count, comment_count, created_at)
  VALUES (v_post3_id, v_group1_id, v_user_id, v_user_handle, '网格交易策略的参数优化心得',
    '运行网格策略一个月了，分享一下参数调优经验。网格间距建议 1-2%，网格数量 20-30 格比较合适。',
    8, 3, NOW() - INTERVAL '5 hours');

  v_post4_id := uuid_generate_v4();
  INSERT INTO posts (id, group_id, author_id, author_handle, title, content, like_count, comment_count, created_at)
  VALUES (v_post4_id, v_group2_id, v_user_id, v_user_handle, '从链上数据看 BTC 长期持有者的信心',
    '分析了最近的 HODL Waves 数据：持有 1 年以上的 BTC 占比达到 70%，交易所余额持续下降。这些数据表明长期持有者信心坚定！💎🙌',
    45, 22, NOW() - INTERVAL '3 days');

  v_post5_id := uuid_generate_v4();
  INSERT INTO posts (id, group_id, author_id, author_handle, title, content, like_count, comment_count, created_at)
  VALUES (v_post5_id, v_group2_id, v_user_id, v_user_handle, '我的 BTC 定投策略分享',
    '从 2020 年开始定投 BTC：每周定投工资的 10%，价格低于 200 日均线时加倍。目前成本约 $25,000，浮盈 100%+。继续坚持！',
    32, 12, NOW() - INTERVAL '12 hours');

  v_post6_id := uuid_generate_v4();
  INSERT INTO posts (id, group_id, author_id, author_handle, title, content, like_count, comment_count, created_at)
  VALUES (v_post6_id, v_group3_id, v_user_id, v_user_handle, '当前 DeFi 收益率最高的几个池子',
    '整理了当前收益较高的 DeFi 挖矿机会：Curve 3pool ~5%, Aave USDC ~8%, Uniswap ETH/USDC ~25%。DYOR，注意风险！',
    18, 6, NOW() - INTERVAL '6 hours');

  v_post7_id := uuid_generate_v4();
  INSERT INTO posts (id, group_id, author_id, author_handle, title, content, like_count, comment_count, created_at)
  VALUES (v_post7_id, v_group3_id, v_user_id, v_user_handle, '⚠️ 警惕新出现的 Rug Pull 项目',
    '发现一个疑似 Rug Pull 项目：合约未开源、管理员持有 80% 代币、无锁仓证明、承诺 >1000% APY。记住：高收益 = 高风险！',
    56, 28, NOW() - INTERVAL '8 hours');

  v_post8_id := uuid_generate_v4();
  INSERT INTO posts (id, group_id, author_id, author_handle, title, content, like_count, comment_count, created_at)
  VALUES (v_post8_id, v_group3_id, v_user_id, v_user_handle, '如何评估 DeFi 协议的安全性？',
    '分享评估 DeFi 项目安全性的 checklist：合约开源、经过审计、TVL 规模、团队背景、代币分配。工具推荐：DefiLlama, Token Sniffer',
    12, 5, NOW() - INTERVAL '2 hours');

  -- 创建评论
  INSERT INTO comments (post_id, author_id, author_handle, content, created_at) VALUES
    (v_post1_id, v_user_id, v_user_handle, '可以试试加入成交量过滤', NOW() - INTERVAL '1 day 20 hours'),
    (v_post1_id, v_user_id, v_user_handle, '建议加止损', NOW() - INTERVAL '1 day 18 hours'),
    (v_post1_id, v_user_id, v_user_handle, '分批建仓可能更稳', NOW() - INTERVAL '1 day 15 hours'),
    (v_post1_id, v_user_id, v_user_handle, 'EMA 周期可以动态调整', NOW() - INTERVAL '1 day 10 hours'),
    (v_post1_id, v_user_id, v_user_handle, '回测3年数据量够吗？', NOW() - INTERVAL '1 day 5 hours'),
    (v_post1_id, v_user_id, v_user_handle, '考虑加入 RSI 过滤假突破', NOW() - INTERVAL '20 hours'),
    (v_post1_id, v_user_id, v_user_handle, '手续费算进去了吗？', NOW() - INTERVAL '10 hours'),
    (v_post1_id, v_user_id, v_user_handle, '求分享代码！', NOW() - INTERVAL '5 hours');

  INSERT INTO comments (post_id, author_id, author_handle, content, created_at) VALUES
    (v_post2_id, v_user_id, v_user_handle, 'LSTM 用来预测价格确实很难', NOW() - INTERVAL '23 hours'),
    (v_post2_id, v_user_id, v_user_handle, '可以考虑加入情绪数据', NOW() - INTERVAL '22 hours'),
    (v_post2_id, v_user_id, v_user_handle, '试试 Transformer 架构', NOW() - INTERVAL '21 hours'),
    (v_post2_id, v_user_id, v_user_handle, '过拟合可以增加 Dropout', NOW() - INTERVAL '20 hours'),
    (v_post2_id, v_user_id, v_user_handle, '建议用更多特征', NOW() - INTERVAL '18 hours'),
    (v_post2_id, v_user_id, v_user_handle, '震荡行情可以加入市场状态分类器', NOW() - INTERVAL '15 hours'),
    (v_post2_id, v_user_id, v_user_handle, '分享一下数据预处理的方法？', NOW() - INTERVAL '12 hours'),
    (v_post2_id, v_user_id, v_user_handle, '用 TimeSeriesSplit 做交叉验证', NOW() - INTERVAL '10 hours'),
    (v_post2_id, v_user_id, v_user_handle, 'XGBoost 可能更适合', NOW() - INTERVAL '8 hours'),
    (v_post2_id, v_user_id, v_user_handle, '加入宏观因子试试', NOW() - INTERVAL '6 hours'),
    (v_post2_id, v_user_id, v_user_handle, '试试 ensemble 多个模型', NOW() - INTERVAL '4 hours'),
    (v_post2_id, v_user_id, v_user_handle, '标签设计很重要', NOW() - INTERVAL '3 hours'),
    (v_post2_id, v_user_id, v_user_handle, '用 PCA 降维可以减少训练成本', NOW() - INTERVAL '2 hours'),
    (v_post2_id, v_user_id, v_user_handle, '期待后续分享！', NOW() - INTERVAL '1 hour'),
    (v_post2_id, v_user_id, v_user_handle, '已关注，等更新', NOW() - INTERVAL '30 minutes');

  INSERT INTO comments (post_id, author_id, author_handle, content, created_at) VALUES
    (v_post3_id, v_user_id, v_user_handle, '网格确实适合震荡', NOW() - INTERVAL '4 hours'),
    (v_post3_id, v_user_id, v_user_handle, '可以加入趋势过滤', NOW() - INTERVAL '3 hours'),
    (v_post3_id, v_user_id, v_user_handle, '感谢分享！', NOW() - INTERVAL '1 hour');

  INSERT INTO comments (post_id, author_id, author_handle, content, created_at) VALUES
    (v_post4_id, v_user_id, v_user_handle, '链上数据确实是最可靠的信号', NOW() - INTERVAL '2 days 20 hours'),
    (v_post4_id, v_user_id, v_user_handle, '70% 持有超过1年，太牛了！', NOW() - INTERVAL '2 days 18 hours'),
    (v_post4_id, v_user_id, v_user_handle, '交易所余额下降是大利好', NOW() - INTERVAL '2 days 15 hours'),
    (v_post4_id, v_user_id, v_user_handle, '囤币党永不为奴！', NOW() - INTERVAL '2 days 12 hours'),
    (v_post4_id, v_user_id, v_user_handle, 'HODL 到下个牛市顶部！', NOW() - INTERVAL '2 days 10 hours'),
    (v_post4_id, v_user_id, v_user_handle, '💎🙌', NOW() - INTERVAL '2 days 8 hours'),
    (v_post4_id, v_user_id, v_user_handle, '分析得很到位', NOW() - INTERVAL '2 days 5 hours'),
    (v_post4_id, v_user_id, v_user_handle, '这就是信仰的力量', NOW() - INTERVAL '2 days 2 hours'),
    (v_post4_id, v_user_id, v_user_handle, '长期看必涨', NOW() - INTERVAL '1 day 20 hours'),
    (v_post4_id, v_user_id, v_user_handle, '现在还是低位，继续定投', NOW() - INTERVAL '1 day 15 hours'),
    (v_post4_id, v_user_id, v_user_handle, '数据不会骗人', NOW() - INTERVAL '1 day 10 hours'),
    (v_post4_id, v_user_id, v_user_handle, 'Glassnode 数据确认！', NOW() - INTERVAL '1 day 5 hours'),
    (v_post4_id, v_user_id, v_user_handle, '目标 15 万美金！', NOW() - INTERVAL '20 hours'),
    (v_post4_id, v_user_id, v_user_handle, '冷钱包才是真正的 HODL', NOW() - INTERVAL '15 hours'),
    (v_post4_id, v_user_id, v_user_handle, '矿工都不卖，我们为什么卖？', NOW() - INTERVAL '10 hours'),
    (v_post4_id, v_user_id, v_user_handle, '机构入场了', NOW() - INTERVAL '8 hours'),
    (v_post4_id, v_user_id, v_user_handle, '楼主分析太专业了！', NOW() - INTERVAL '5 hours'),
    (v_post4_id, v_user_id, v_user_handle, '已收藏', NOW() - INTERVAL '3 hours'),
    (v_post4_id, v_user_id, v_user_handle, '感谢分享', NOW() - INTERVAL '2 hours'),
    (v_post4_id, v_user_id, v_user_handle, 'BTC to the moon! 🚀', NOW() - INTERVAL '1 hour'),
    (v_post4_id, v_user_id, v_user_handle, '已转发！', NOW() - INTERVAL '30 minutes'),
    (v_post4_id, v_user_id, v_user_handle, '必须支持！', NOW() - INTERVAL '10 minutes');

  INSERT INTO comments (post_id, author_id, author_handle, content, created_at) VALUES
    (v_post5_id, v_user_id, v_user_handle, '定投是最好的策略', NOW() - INTERVAL '11 hours'),
    (v_post5_id, v_user_id, v_user_handle, '成本 25K 太优秀了！', NOW() - INTERVAL '10 hours'),
    (v_post5_id, v_user_id, v_user_handle, '200 日均线策略不错', NOW() - INTERVAL '9 hours'),
    (v_post5_id, v_user_id, v_user_handle, '自动定投确实省心', NOW() - INTERVAL '8 hours'),
    (v_post5_id, v_user_id, v_user_handle, '坚持就是胜利！', NOW() - INTERVAL '6 hours'),
    (v_post5_id, v_user_id, v_user_handle, '用什么平台定投的？', NOW() - INTERVAL '5 hours'),
    (v_post5_id, v_user_id, v_user_handle, '心态管理太重要了', NOW() - INTERVAL '4 hours'),
    (v_post5_id, v_user_id, v_user_handle, '学习了', NOW() - INTERVAL '3 hours'),
    (v_post5_id, v_user_id, v_user_handle, '10% 工资挺合理', NOW() - INTERVAL '2 hours'),
    (v_post5_id, v_user_id, v_user_handle, '已 follow', NOW() - INTERVAL '1 hour'),
    (v_post5_id, v_user_id, v_user_handle, '4 年定投，太厉害了', NOW() - INTERVAL '30 minutes'),
    (v_post5_id, v_user_id, v_user_handle, 'HODL 一族 +1', NOW() - INTERVAL '15 minutes');

  INSERT INTO comments (post_id, author_id, author_handle, content, created_at) VALUES
    (v_post6_id, v_user_id, v_user_handle, '稳定币池收益太低了', NOW() - INTERVAL '5 hours'),
    (v_post6_id, v_user_id, v_user_handle, 'LP 挖矿注意无常损失', NOW() - INTERVAL '4 hours'),
    (v_post6_id, v_user_id, v_user_handle, '新项目 200% 太吓人了', NOW() - INTERVAL '3 hours'),
    (v_post6_id, v_user_id, v_user_handle, '感谢整理！', NOW() - INTERVAL '2 hours'),
    (v_post6_id, v_user_id, v_user_handle, 'Aave 8% 还可以', NOW() - INTERVAL '1 hour'),
    (v_post6_id, v_user_id, v_user_handle, '建议分散投资', NOW() - INTERVAL '30 minutes');

  INSERT INTO comments (post_id, author_id, author_handle, content, created_at) VALUES
    (v_post7_id, v_user_id, v_user_handle, '感谢预警！', NOW() - INTERVAL '7 hours 50 minutes'),
    (v_post7_id, v_user_id, v_user_handle, '80% 代币在管理员手里太可怕了', NOW() - INTERVAL '7 hours 40 minutes'),
    (v_post7_id, v_user_id, v_user_handle, '这种项目远离！', NOW() - INTERVAL '7 hours 30 minutes'),
    (v_post7_id, v_user_id, v_user_handle, '1000% APY 肯定是骗局', NOW() - INTERVAL '7 hours'),
    (v_post7_id, v_user_id, v_user_handle, '合约不开源就别碰', NOW() - INTERVAL '6 hours 30 minutes'),
    (v_post7_id, v_user_id, v_user_handle, '已经有人被骗了吗？', NOW() - INTERVAL '6 hours'),
    (v_post7_id, v_user_id, v_user_handle, '能说一下项目名称吗？', NOW() - INTERVAL '5 hours 30 minutes'),
    (v_post7_id, v_user_id, v_user_handle, '转发让更多人看到', NOW() - INTERVAL '5 hours'),
    (v_post7_id, v_user_id, v_user_handle, '小心驶得万年船', NOW() - INTERVAL '4 hours 30 minutes'),
    (v_post7_id, v_user_id, v_user_handle, '贪婪是亏损的根源', NOW() - INTERVAL '4 hours'),
    (v_post7_id, v_user_id, v_user_handle, 'Rug Pull 防不胜防', NOW() - INTERVAL '3 hours 30 minutes'),
    (v_post7_id, v_user_id, v_user_handle, '建议只玩头部项目', NOW() - INTERVAL '3 hours'),
    (v_post7_id, v_user_id, v_user_handle, '新项目至少等审计报告', NOW() - INTERVAL '2 hours 30 minutes'),
    (v_post7_id, v_user_id, v_user_handle, '机器人刷评论太明显了', NOW() - INTERVAL '2 hours'),
    (v_post7_id, v_user_id, v_user_handle, '没锁仓就是随时可以跑路', NOW() - INTERVAL '1 hour 30 minutes'),
    (v_post7_id, v_user_id, v_user_handle, '高收益 = 高风险，记住了', NOW() - INTERVAL '1 hour'),
    (v_post7_id, v_user_id, v_user_handle, '已收藏这个 checklist', NOW() - INTERVAL '45 minutes'),
    (v_post7_id, v_user_id, v_user_handle, '楼主好人一生平安', NOW() - INTERVAL '30 minutes'),
    (v_post7_id, v_user_id, v_user_handle, '安全第一！', NOW() - INTERVAL '20 minutes'),
    (v_post7_id, v_user_id, v_user_handle, '必须顶起来', NOW() - INTERVAL '10 minutes'),
    (v_post7_id, v_user_id, v_user_handle, '+1 警惕新项目', NOW() - INTERVAL '5 minutes'),
    (v_post7_id, v_user_id, v_user_handle, '能不能把项目名称私信我？', NOW() - INTERVAL '3 minutes'),
    (v_post7_id, v_user_id, v_user_handle, '差点就冲进去了，谢谢楼主', NOW() - INTERVAL '2 minutes'),
    (v_post7_id, v_user_id, v_user_handle, '这帖子救了我！', NOW() - INTERVAL '1 minute'),
    (v_post7_id, v_user_id, v_user_handle, '已举报该项目', NOW() - INTERVAL '30 seconds'),
    (v_post7_id, v_user_id, v_user_handle, '大家转发一下！', NOW() - INTERVAL '15 seconds'),
    (v_post7_id, v_user_id, v_user_handle, '置顶这个帖子！', NOW() - INTERVAL '5 seconds'),
    (v_post7_id, v_user_id, v_user_handle, '🙏', NOW());

  INSERT INTO comments (post_id, author_id, author_handle, content, created_at) VALUES
    (v_post8_id, v_user_id, v_user_handle, '这个 checklist 太实用了', NOW() - INTERVAL '1 hour 30 minutes'),
    (v_post8_id, v_user_id, v_user_handle, 'Token Sniffer 推荐一下', NOW() - INTERVAL '1 hour'),
    (v_post8_id, v_user_id, v_user_handle, '审计报告一定要看', NOW() - INTERVAL '45 minutes'),
    (v_post8_id, v_user_id, v_user_handle, '匿名团队 + 高收益 = 跑路', NOW() - INTERVAL '30 minutes'),
    (v_post8_id, v_user_id, v_user_handle, '已收藏，感谢分享！', NOW() - INTERVAL '10 minutes');

  RAISE NOTICE '✅ Mock 数据创建成功！创建了 3 个小组，8 篇帖子';
END $$;

-- ============================================
-- 完成
-- ============================================

SELECT '✅ 数据库设置完成！' AS status;


