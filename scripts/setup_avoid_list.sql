-- ============================================
-- 风险提示功能数据库表
-- 原"避雷榜"改造为更合规的"风险提示"系统
-- ============================================

-- ============================================
-- 风险投票表（原 avoid_votes 改名）
-- ============================================

-- 如果已存在旧表，先迁移数据
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'avoid_votes') THEN
    -- 表已存在，只需添加新字段
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns 
      WHERE table_name = 'avoid_votes' AND column_name = 'status'
    ) THEN
      ALTER TABLE avoid_votes ADD COLUMN status TEXT DEFAULT 'active';
    END IF;
  ELSE
    -- 创建新表
    CREATE TABLE avoid_votes (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
      trader_id TEXT NOT NULL,
      source TEXT NOT NULL,
      
      -- 投票详情
      reason TEXT,
      reason_type TEXT CHECK (reason_type IN (
        'high_drawdown',
        'fake_data',
        'inconsistent',
        'poor_communication',
        'other'
      )),
      loss_amount NUMERIC,
      loss_percent NUMERIC,
      follow_duration_days INTEGER,
      
      -- 证据
      screenshot_url TEXT,
      
      -- 状态（用于申诉处理）
      status TEXT DEFAULT 'active' CHECK (status IN ('active', 'under_review', 'dismissed')),
      
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      
      UNIQUE(user_id, trader_id, source)
    );
  END IF;
END $$;

-- ============================================
-- 申诉表
-- ============================================

CREATE TABLE IF NOT EXISTS risk_appeals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trader_id TEXT NOT NULL,
  source TEXT NOT NULL,
  
  -- 申诉人信息
  appellant_user_id UUID REFERENCES auth.users(id),  -- 如果是认领的交易员
  appellant_email TEXT,                               -- 未认领时的联系邮箱
  
  -- 申诉内容
  appeal_reason TEXT NOT NULL,
  evidence_urls TEXT[],                               -- 证据链接
  
  -- 处理状态
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'reviewing', 'approved', 'rejected')),
  reviewed_by UUID REFERENCES auth.users(id),
  reviewed_at TIMESTAMPTZ,
  review_notes TEXT,
  
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- 风险提示聚合视图
-- 修改：至少 10 票才显示，匿名化处理
-- ============================================

DROP VIEW IF EXISTS trader_avoid_scores;
DROP VIEW IF EXISTS trader_risk_alerts;

CREATE VIEW trader_risk_alerts AS
SELECT 
  -- 匿名化：只显示 ID 末四位
  CONCAT('****', RIGHT(trader_id, 4)) as masked_trader_id,
  trader_id as internal_trader_id,  -- 仅管理员可见
  source,
  COUNT(*) as report_count,
  
  -- 风险类型统计
  COUNT(CASE WHEN reason_type = 'high_drawdown' THEN 1 END) as high_drawdown_count,
  COUNT(CASE WHEN reason_type = 'fake_data' THEN 1 END) as fake_data_count,
  COUNT(CASE WHEN reason_type = 'inconsistent' THEN 1 END) as inconsistent_count,
  
  -- 主要风险类型
  CASE 
    WHEN COUNT(CASE WHEN reason_type = 'high_drawdown' THEN 1 END) >= 
         GREATEST(COUNT(CASE WHEN reason_type = 'fake_data' THEN 1 END),
                  COUNT(CASE WHEN reason_type = 'inconsistent' THEN 1 END))
    THEN 'high_drawdown'
    WHEN COUNT(CASE WHEN reason_type = 'fake_data' THEN 1 END) >= 
         COUNT(CASE WHEN reason_type = 'inconsistent' THEN 1 END)
    THEN 'fake_data'
    ELSE 'inconsistent'
  END as primary_risk_type,
  
  -- 统计数据
  ROUND(AVG(loss_percent)::NUMERIC, 1) as avg_loss_percent,
  ROUND(AVG(follow_duration_days)::NUMERIC, 0) as avg_follow_days,
  
  -- 风险等级
  CASE 
    WHEN COUNT(*) >= 50 THEN 'critical'
    WHEN COUNT(*) >= 30 THEN 'high'
    WHEN COUNT(*) >= 15 THEN 'medium'
    ELSE 'low'
  END as risk_level,
  
  -- 有无待处理申诉
  EXISTS (
    SELECT 1 FROM risk_appeals ra 
    WHERE ra.trader_id = av.trader_id 
    AND ra.source = av.source 
    AND ra.status IN ('pending', 'reviewing')
  ) as has_pending_appeal,
  
  MAX(created_at) as latest_report_at
FROM avoid_votes av
WHERE status = 'active'
GROUP BY trader_id, source
HAVING COUNT(*) >= 10;  -- 提高阈值到 10 票

-- ============================================
-- 索引优化
-- ============================================

CREATE INDEX IF NOT EXISTS idx_avoid_votes_trader ON avoid_votes(trader_id, source);
CREATE INDEX IF NOT EXISTS idx_avoid_votes_user ON avoid_votes(user_id);
CREATE INDEX IF NOT EXISTS idx_avoid_votes_reason ON avoid_votes(reason_type);
CREATE INDEX IF NOT EXISTS idx_avoid_votes_status ON avoid_votes(status);
CREATE INDEX IF NOT EXISTS idx_avoid_votes_created ON avoid_votes(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_risk_appeals_trader ON risk_appeals(trader_id, source);
CREATE INDEX IF NOT EXISTS idx_risk_appeals_status ON risk_appeals(status);

-- ============================================
-- 自动更新 updated_at 触发器
-- ============================================

CREATE OR REPLACE FUNCTION update_avoid_votes_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_avoid_votes_updated_at ON avoid_votes;
CREATE TRIGGER trg_avoid_votes_updated_at
  BEFORE UPDATE ON avoid_votes
  FOR EACH ROW
  EXECUTE FUNCTION update_avoid_votes_updated_at();

-- ============================================
-- Row Level Security (RLS)
-- ============================================

ALTER TABLE avoid_votes ENABLE ROW LEVEL SECURITY;
ALTER TABLE risk_appeals ENABLE ROW LEVEL SECURITY;

-- 风险投票策略
DROP POLICY IF EXISTS "Avoid votes are viewable by everyone" ON avoid_votes;
CREATE POLICY "Active votes are viewable" ON avoid_votes
  FOR SELECT USING (status = 'active');

DROP POLICY IF EXISTS "Users can create their own avoid votes" ON avoid_votes;
CREATE POLICY "Users can create risk reports" ON avoid_votes
  FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update their own avoid votes" ON avoid_votes;
CREATE POLICY "Users can update own reports" ON avoid_votes
  FOR UPDATE USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete their own avoid votes" ON avoid_votes;
CREATE POLICY "Users can delete own reports" ON avoid_votes
  FOR DELETE USING (auth.uid() = user_id);

-- 申诉策略
CREATE POLICY "Anyone can view approved appeals"
  ON risk_appeals FOR SELECT
  USING (status = 'approved' OR appellant_user_id = auth.uid());

CREATE POLICY "Authenticated users can submit appeals"
  ON risk_appeals FOR INSERT
  TO authenticated
  WITH CHECK (true);

-- ============================================
-- 辅助函数：提交风险报告
-- ============================================

CREATE OR REPLACE FUNCTION submit_risk_report(
  p_trader_id TEXT,
  p_source TEXT,
  p_reason_type TEXT,
  p_reason TEXT DEFAULT NULL,
  p_loss_percent NUMERIC DEFAULT NULL,
  p_follow_duration INTEGER DEFAULT NULL
)
RETURNS UUID AS $$
DECLARE
  v_id UUID;
BEGIN
  INSERT INTO avoid_votes (
    user_id, trader_id, source, 
    reason_type, reason, loss_percent, follow_duration_days
  ) VALUES (
    auth.uid(), p_trader_id, p_source,
    p_reason_type, p_reason, p_loss_percent, p_follow_duration
  )
  ON CONFLICT (user_id, trader_id, source) DO UPDATE SET
    reason_type = EXCLUDED.reason_type,
    reason = EXCLUDED.reason,
    loss_percent = EXCLUDED.loss_percent,
    follow_duration_days = EXCLUDED.follow_duration_days,
    updated_at = NOW()
  RETURNING id INTO v_id;
  
  RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================
-- 辅助函数：提交申诉
-- ============================================

CREATE OR REPLACE FUNCTION submit_risk_appeal(
  p_trader_id TEXT,
  p_source TEXT,
  p_appeal_reason TEXT,
  p_evidence_urls TEXT[] DEFAULT NULL,
  p_email TEXT DEFAULT NULL
)
RETURNS UUID AS $$
DECLARE
  v_id UUID;
BEGIN
  -- 检查是否已有待处理的申诉
  IF EXISTS (
    SELECT 1 FROM risk_appeals 
    WHERE trader_id = p_trader_id 
    AND source = p_source 
    AND status IN ('pending', 'reviewing')
  ) THEN
    RAISE EXCEPTION 'Already has pending appeal for this trader';
  END IF;
  
  INSERT INTO risk_appeals (
    trader_id, source, 
    appellant_user_id, appellant_email,
    appeal_reason, evidence_urls
  ) VALUES (
    p_trader_id, p_source,
    auth.uid(), p_email,
    p_appeal_reason, p_evidence_urls
  )
  RETURNING id INTO v_id;
  
  RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
