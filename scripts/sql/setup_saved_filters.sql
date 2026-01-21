-- 保存的筛选配置表
-- Pro 会员功能：多条件叠加筛选，保存筛选结果，一键复用
-- 在 Supabase Dashboard 的 SQL Editor 中运行此脚本

-- ============================================
-- 1. 创建 saved_filters 表
-- ============================================
CREATE TABLE IF NOT EXISTS saved_filters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  -- 筛选配置 JSON
  filter_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- 使用统计
  use_count INTEGER DEFAULT 0,
  last_used_at TIMESTAMPTZ,
  -- 是否为默认筛选
  is_default BOOLEAN DEFAULT false,
  -- 时间戳
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- filter_config 结构示例:
-- {
--   "category": ["futures", "spot", "web3"],  -- 类型：合约/现货/链上
--   "exchange": ["binance", "bybit", "bitget"], -- 交易所
--   "roi_min": 0,        -- 最小 ROI
--   "roi_max": 100,      -- 最大 ROI
--   "drawdown_min": 0,   -- 最小回撤
--   "drawdown_max": 50,  -- 最大回撤
--   "period": "90D",     -- 周期：7D/30D/90D
--   "min_pnl": 1000,     -- 最小 PnL
--   "min_score": 40,     -- 最小 Arena Score
--   "min_win_rate": 50   -- 最小胜率
-- }

-- ============================================
-- 2. 创建索引
-- ============================================
CREATE INDEX IF NOT EXISTS idx_saved_filters_user ON saved_filters(user_id);
CREATE INDEX IF NOT EXISTS idx_saved_filters_default ON saved_filters(user_id, is_default) WHERE is_default = true;
CREATE INDEX IF NOT EXISTS idx_saved_filters_updated ON saved_filters(user_id, updated_at DESC);

-- ============================================
-- 3. 设置 RLS 策略
-- ============================================
ALTER TABLE saved_filters ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view their own filters" ON saved_filters;
DROP POLICY IF EXISTS "Users can create their own filters" ON saved_filters;
DROP POLICY IF EXISTS "Users can update their own filters" ON saved_filters;
DROP POLICY IF EXISTS "Users can delete their own filters" ON saved_filters;

CREATE POLICY "Users can view their own filters"
  ON saved_filters FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can create their own filters"
  ON saved_filters FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own filters"
  ON saved_filters FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own filters"
  ON saved_filters FOR DELETE
  USING (auth.uid() = user_id);

-- ============================================
-- 4. 更新 updated_at 触发器
-- ============================================
CREATE OR REPLACE FUNCTION update_saved_filters_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_saved_filters_updated_at ON saved_filters;

CREATE TRIGGER trigger_update_saved_filters_updated_at
  BEFORE UPDATE ON saved_filters
  FOR EACH ROW
  EXECUTE FUNCTION update_saved_filters_updated_at();

-- ============================================
-- 5. 确保只有一个默认筛选
-- ============================================
CREATE OR REPLACE FUNCTION ensure_single_default_filter()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.is_default = true THEN
    -- 将该用户的其他筛选设为非默认
    UPDATE saved_filters 
    SET is_default = false 
    WHERE user_id = NEW.user_id 
      AND id != NEW.id 
      AND is_default = true;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_ensure_single_default_filter ON saved_filters;

CREATE TRIGGER trigger_ensure_single_default_filter
  BEFORE INSERT OR UPDATE ON saved_filters
  FOR EACH ROW
  WHEN (NEW.is_default = true)
  EXECUTE FUNCTION ensure_single_default_filter();

-- ============================================
-- 6. 创建视图：用户筛选配置汇总
-- ============================================
CREATE OR REPLACE VIEW user_filters_summary AS
SELECT 
  user_id,
  COUNT(*) as total_filters,
  SUM(use_count) as total_uses,
  MAX(last_used_at) as last_used,
  COUNT(*) FILTER (WHERE is_default) as has_default
FROM saved_filters
GROUP BY user_id;

-- ============================================
-- 完成
-- ============================================
-- 功能说明：
-- 1. 用户可保存多个筛选配置
-- 2. 每个配置包含：类型、交易所、ROI区间、回撤区间、周期等条件
-- 3. 可设置一个默认筛选，自动应用于首页
-- 4. 记录使用次数和最后使用时间
