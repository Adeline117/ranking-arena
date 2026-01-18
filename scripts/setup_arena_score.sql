-- Arena Score 数据库函数
-- 用于在 Postgres 层面计算 Arena Score
-- 
-- 评分结构：收益分（0-85）+ 稳定/风险分（0-15）= 总分（0-100）

-- ============================================
-- 工具函数
-- ============================================

-- clip 函数：将值限制在 [min_val, max_val] 范围内
CREATE OR REPLACE FUNCTION clip(val NUMERIC, min_val NUMERIC, max_val NUMERIC)
RETURNS NUMERIC AS $$
BEGIN
  RETURN GREATEST(min_val, LEAST(max_val, val));
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- safe_log1p 函数：安全的 ln(1+x)，当 x <= -1 时返回 0
CREATE OR REPLACE FUNCTION safe_log1p(x NUMERIC)
RETURNS NUMERIC AS $$
BEGIN
  IF x <= -1 THEN
    RETURN 0;
  END IF;
  RETURN LN(1 + x);
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- ============================================
-- Arena Score 计算函数
-- ============================================

-- 计算单个时间段的 Arena Score
-- @param roi: ROI 百分比（如 25 表示 25%）
-- @param pnl: 已实现盈亏（USD）
-- @param max_drawdown: 最大回撤百分比（如 20 表示 20%）
-- @param win_rate: 胜率百分比（如 60 表示 60%）
-- @param period: 时间段 ('7D', '30D', '90D')
-- @returns: Arena Score (0-100)
CREATE OR REPLACE FUNCTION calculate_arena_score(
  roi NUMERIC,
  pnl NUMERIC,
  max_drawdown NUMERIC,
  win_rate NUMERIC,
  period TEXT
)
RETURNS TABLE (
  total_score NUMERIC,
  return_score NUMERIC,
  drawdown_score NUMERIC,
  stability_score NUMERIC,
  meets_threshold BOOLEAN
) AS $$
DECLARE
  -- 入榜门槛
  pnl_threshold NUMERIC;
  -- 评分参数
  tanh_coeff NUMERIC;
  roi_exponent NUMERIC;
  mdd_threshold NUMERIC;
  win_rate_cap NUMERIC;
  -- 计算中间值
  days INTEGER;
  roi_decimal NUMERIC;
  intensity NUMERIC;
  r0 NUMERIC;
  -- 分数
  v_return_score NUMERIC;
  v_drawdown_score NUMERIC;
  v_stability_score NUMERIC;
  v_total_score NUMERIC;
  v_meets_threshold BOOLEAN;
  -- 常量
  win_rate_baseline CONSTANT NUMERIC := 45;
  max_return CONSTANT NUMERIC := 85;
  max_drawdown_score CONSTANT NUMERIC := 8;
  max_stability CONSTANT NUMERIC := 7;
BEGIN
  -- 根据时间段设置参数
  -- 注：tanh_coeff 越小，曲线越平缓，高收益者分数压缩更明显
  CASE period
    WHEN '7D' THEN
      pnl_threshold := 300;
      tanh_coeff := 0.08;    -- 从 0.12 降低，减少满分
      roi_exponent := 1.8;
      mdd_threshold := 15;
      win_rate_cap := 62;
      days := 7;
    WHEN '30D' THEN
      pnl_threshold := 1000;
      tanh_coeff := 0.15;    -- 从 0.22 降低，减少满分
      roi_exponent := 1.6;
      mdd_threshold := 30;
      win_rate_cap := 68;
      days := 30;
    WHEN '90D' THEN
      pnl_threshold := 3000;
      tanh_coeff := 0.18;    -- 保持不变
      roi_exponent := 1.6;
      mdd_threshold := 40;
      win_rate_cap := 70;
      days := 90;
    ELSE
      -- 默认使用 90D 参数
      pnl_threshold := 3000;
      tanh_coeff := 0.18;
      roi_exponent := 1.6;
      mdd_threshold := 40;
      win_rate_cap := 70;
      days := 90;
  END CASE;
  
  -- 检查入榜门槛
  v_meets_threshold := COALESCE(pnl, 0) > pnl_threshold;
  
  -- 计算收益分 (0-85)
  -- I_d = (365 / d) * ln(1 + ROI_d)
  roi_decimal := COALESCE(roi, 0) / 100.0;
  intensity := (365.0 / days) * safe_log1p(roi_decimal);
  
  -- R0 = tanh(coeff * I)
  r0 := TANH(tanh_coeff * intensity);
  
  -- ReturnScore = 85 * R0^exponent
  IF r0 <= 0 THEN
    v_return_score := 0;
  ELSE
    v_return_score := max_return * POWER(r0, roi_exponent);
  END IF;
  v_return_score := clip(v_return_score, 0, max_return);
  
  -- 计算回撤分 (0-8)
  -- DrawdownScore = 8 * clip(1 - MDD/阈值, 0, 1)
  IF max_drawdown IS NULL THEN
    v_drawdown_score := max_drawdown_score * 0.5;
  ELSE
    v_drawdown_score := max_drawdown_score * clip(1 - ABS(max_drawdown) / mdd_threshold, 0, 1);
  END IF;
  v_drawdown_score := clip(v_drawdown_score, 0, max_drawdown_score);
  
  -- 计算稳定分 (0-7)
  -- StabilityScore = 7 * clip((WinRate - 0.45) / (上限 - 0.45), 0, 1)
  IF win_rate IS NULL THEN
    v_stability_score := max_stability * 0.5;
  ELSE
    v_stability_score := max_stability * clip((win_rate - win_rate_baseline) / (win_rate_cap - win_rate_baseline), 0, 1);
  END IF;
  v_stability_score := clip(v_stability_score, 0, max_stability);
  
  -- 总分
  v_total_score := clip(v_return_score + v_drawdown_score + v_stability_score, 0, 100);
  
  -- 返回结果（保留2位小数）
  RETURN QUERY SELECT 
    ROUND(v_total_score, 2),
    ROUND(v_return_score, 2),
    ROUND(v_drawdown_score, 2),
    ROUND(v_stability_score, 2),
    v_meets_threshold;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- 简化版：只返回总分
CREATE OR REPLACE FUNCTION arena_score(
  roi NUMERIC,
  pnl NUMERIC,
  max_drawdown NUMERIC,
  win_rate NUMERIC,
  period TEXT
)
RETURNS NUMERIC AS $$
DECLARE
  result RECORD;
BEGIN
  SELECT * INTO result FROM calculate_arena_score(roi, pnl, max_drawdown, win_rate, period);
  IF result.meets_threshold THEN
    RETURN result.total_score;
  ELSE
    RETURN NULL;  -- 未达门槛返回 NULL
  END IF;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- ============================================
-- 总体分数计算函数
-- ============================================

-- 计算总体分数（个人主页用）
-- OverallScore = 0.70 * Score_90 + 0.25 * Score_30 + 0.05 * Score_7
CREATE OR REPLACE FUNCTION calculate_overall_score(
  score_7d NUMERIC,
  score_30d NUMERIC,
  score_90d NUMERIC
)
RETURNS NUMERIC AS $$
DECLARE
  has_7d BOOLEAN := score_7d IS NOT NULL;
  has_30d BOOLEAN := score_30d IS NOT NULL;
  has_90d BOOLEAN := score_90d IS NOT NULL;
  overall NUMERIC;
BEGIN
  IF has_90d AND has_30d AND has_7d THEN
    -- 完整数据：标准加权
    overall := 0.70 * score_90d + 0.25 * score_30d + 0.05 * score_7d;
  ELSIF has_30d AND has_7d AND NOT has_90d THEN
    -- 缺 90D：降权惩罚
    overall := (0.80 * score_30d + 0.20 * score_7d) * 0.85;
  ELSIF has_7d AND NOT has_30d AND NOT has_90d THEN
    -- 只有 7D：强惩罚
    overall := score_7d * 0.70;
  ELSIF has_90d AND NOT has_30d AND NOT has_7d THEN
    -- 只有 90D
    overall := score_90d * 0.90;
  ELSIF has_90d AND has_30d AND NOT has_7d THEN
    -- 有 90D 和 30D，缺 7D
    overall := 0.70 * score_90d + 0.30 * score_30d;
  ELSIF has_90d AND has_7d AND NOT has_30d THEN
    -- 有 90D 和 7D，缺 30D
    overall := 0.70 * score_90d + 0.30 * score_7d;
  ELSIF has_30d AND NOT has_7d AND NOT has_90d THEN
    -- 只有 30D
    overall := score_30d * 0.80;
  ELSE
    -- 无数据
    overall := 0;
  END IF;
  
  RETURN ROUND(clip(overall, 0, 100), 2);
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- ============================================
-- 视图：Arena 排行榜（可选，用于快速查询）
-- ============================================

-- 注意：这些视图会实时计算，如果数据量大可能较慢
-- 建议在 API 层面计算分数，或者使用 materialized view 定时刷新

-- 创建或替换 90D 排行榜视图
CREATE OR REPLACE VIEW arena_leaderboard_90d AS
WITH latest_snapshots AS (
  SELECT DISTINCT ON (source, source_trader_id)
    ts.*,
    tsrc.handle,
    tsrc.profile_url as avatar_url
  FROM trader_snapshots ts
  LEFT JOIN trader_sources tsrc 
    ON ts.source = tsrc.source AND ts.source_trader_id = tsrc.source_trader_id
  WHERE ts.season_id = '90D'
  ORDER BY ts.source, ts.source_trader_id, ts.captured_at DESC
),
scored AS (
  SELECT 
    ls.*,
    (calculate_arena_score(ls.roi, ls.pnl, ls.max_drawdown, ls.win_rate, '90D')).*
  FROM latest_snapshots ls
)
SELECT 
  source_trader_id as id,
  COALESCE(handle, source_trader_id) as handle,
  source,
  roi,
  pnl,
  win_rate,
  max_drawdown,
  trades_count,
  followers,
  avatar_url,
  total_score as arena_score,
  return_score,
  drawdown_score,
  stability_score,
  ROW_NUMBER() OVER (ORDER BY total_score DESC, ABS(COALESCE(max_drawdown, 999)) ASC) as rank
FROM scored
WHERE meets_threshold = true
ORDER BY total_score DESC, ABS(COALESCE(max_drawdown, 999)) ASC
LIMIT 100;

-- 创建或替换 30D 排行榜视图
CREATE OR REPLACE VIEW arena_leaderboard_30d AS
WITH latest_snapshots AS (
  SELECT DISTINCT ON (source, source_trader_id)
    ts.*,
    tsrc.handle,
    tsrc.profile_url as avatar_url
  FROM trader_snapshots ts
  LEFT JOIN trader_sources tsrc 
    ON ts.source = tsrc.source AND ts.source_trader_id = tsrc.source_trader_id
  WHERE ts.season_id = '30D'
  ORDER BY ts.source, ts.source_trader_id, ts.captured_at DESC
),
scored AS (
  SELECT 
    ls.*,
    (calculate_arena_score(ls.roi, ls.pnl, ls.max_drawdown, ls.win_rate, '30D')).*
  FROM latest_snapshots ls
)
SELECT 
  source_trader_id as id,
  COALESCE(handle, source_trader_id) as handle,
  source,
  roi,
  pnl,
  win_rate,
  max_drawdown,
  trades_count,
  followers,
  avatar_url,
  total_score as arena_score,
  return_score,
  drawdown_score,
  stability_score,
  ROW_NUMBER() OVER (ORDER BY total_score DESC, ABS(COALESCE(max_drawdown, 999)) ASC) as rank
FROM scored
WHERE meets_threshold = true
ORDER BY total_score DESC, ABS(COALESCE(max_drawdown, 999)) ASC
LIMIT 100;

-- 创建或替换 7D 排行榜视图
CREATE OR REPLACE VIEW arena_leaderboard_7d AS
WITH latest_snapshots AS (
  SELECT DISTINCT ON (source, source_trader_id)
    ts.*,
    tsrc.handle,
    tsrc.profile_url as avatar_url
  FROM trader_snapshots ts
  LEFT JOIN trader_sources tsrc 
    ON ts.source = tsrc.source AND ts.source_trader_id = tsrc.source_trader_id
  WHERE ts.season_id = '7D'
  ORDER BY ts.source, ts.source_trader_id, ts.captured_at DESC
),
scored AS (
  SELECT 
    ls.*,
    (calculate_arena_score(ls.roi, ls.pnl, ls.max_drawdown, ls.win_rate, '7D')).*
  FROM latest_snapshots ls
)
SELECT 
  source_trader_id as id,
  COALESCE(handle, source_trader_id) as handle,
  source,
  roi,
  pnl,
  win_rate,
  max_drawdown,
  trades_count,
  followers,
  avatar_url,
  total_score as arena_score,
  return_score,
  drawdown_score,
  stability_score,
  ROW_NUMBER() OVER (ORDER BY total_score DESC, ABS(COALESCE(max_drawdown, 999)) ASC) as rank
FROM scored
WHERE meets_threshold = true
ORDER BY total_score DESC, ABS(COALESCE(max_drawdown, 999)) ASC
LIMIT 100;

-- ============================================
-- 使用示例
-- ============================================

-- 1. 计算单个交易员的分数：
-- SELECT * FROM calculate_arena_score(150.5, 5000, 25.3, 62.5, '90D');

-- 2. 使用简化函数获取分数：
-- SELECT arena_score(150.5, 5000, 25.3, 62.5, '90D');

-- 3. 计算总体分数：
-- SELECT calculate_overall_score(75.5, 68.2, 45.0);

-- 4. 查询排行榜：
-- SELECT * FROM arena_leaderboard_90d LIMIT 20;
