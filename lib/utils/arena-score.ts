/**
 * Arena Score 计算模块
 * 
 * 评分结构：收益分（0-85）+ 稳定/风险分（0-15）= 总分（0-100）
 * 
 * 目标分布：
 * - 大多数普通交易员：30-40 分
 * - 60 分 = 明显优秀交易员
 * - 80 分以上 = 极少数（凤毛麟角）
 */

// ============================================
// 类型定义
// ============================================

export type Period = '7D' | '30D' | '90D'

export interface TraderScoreInput {
  roi: number          // ROI（百分比，如 25% = 25）
  pnl: number          // 已实现盈亏（USD）
  maxDrawdown: number | null  // 最大回撤（百分比，如 20% = 20）
  winRate: number | null      // 胜率（百分比，如 60% = 60）
}

export interface ArenaScoreResult {
  totalScore: number      // 总分 (0-100)
  returnScore: number     // 收益分 (0-85)
  drawdownScore: number   // 回撤分 (0-8)
  stabilityScore: number  // 稳定分 (0-7)
  meetsThreshold: boolean // 是否达到入榜门槛
}

export interface OverallScoreInput {
  score7d: number | null
  score30d: number | null
  score90d: number | null
}

// ============================================
// 配置参数
// ============================================

export const ARENA_CONFIG = {
  // 入榜 PnL 门槛（唯一硬条件）
  PNL_THRESHOLD: {
    '7D': 300,
    '30D': 1000,
    '90D': 3000,
  },
  
  // 评分参数
  // 注：tanh 系数越小，曲线越平缓，高收益者分数压缩更明显
  PARAMS: {
    '7D': {
      tanhCoeff: 0.08,      // tanh 系数（从 0.12 降低，减少满分）
      roiExponent: 1.8,     // ROI 指数
      mddThreshold: 15,     // 回撤阈值（百分比）
      winRateCap: 62,       // 胜率满分线（百分比）
    },
    '30D': {
      tanhCoeff: 0.15,      // tanh 系数（从 0.22 降低，减少满分）
      roiExponent: 1.6,
      mddThreshold: 30,
      winRateCap: 68,
    },
    '90D': {
      tanhCoeff: 0.18,      // 保持不变
      roiExponent: 1.6,
      mddThreshold: 40,
      winRateCap: 70,
    },
  },
  
  // 稳定性计算的基线胜率
  WIN_RATE_BASELINE: 45,
  
  // 分数权重
  MAX_RETURN_SCORE: 85,
  MAX_DRAWDOWN_SCORE: 8,
  MAX_STABILITY_SCORE: 7,
  
  // 总体分数权重
  OVERALL_WEIGHTS: {
    '90D': 0.70,
    '30D': 0.25,
    '7D': 0.05,
  },
  
  // 缺失数据惩罚
  MISSING_90D_PENALTY: 0.85,
  ONLY_7D_PENALTY: 0.70,
} as const

// ============================================
// 工具函数
// ============================================

/**
 * 将值限制在 [min, max] 范围内
 */
export function clip(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

/**
 * 安全的自然对数，处理负数和零
 * ln(1 + x)，当 x <= -1 时返回 0
 */
export function safeLog1p(x: number): number {
  if (x <= -1) return 0
  return Math.log(1 + x)
}

/**
 * 获取时间段天数
 */
function getPeriodDays(period: Period): number {
  switch (period) {
    case '7D': return 7
    case '30D': return 30
    case '90D': return 90
  }
}

// ============================================
// 核心计算函数
// ============================================

/**
 * 计算 ROI 强度
 * I_d = (365 / d) * ln(1 + ROI_d)
 * 
 * @param roi ROI 百分比（如 25 表示 25%）
 * @param period 时间段
 */
export function calculateRoiIntensity(roi: number, period: Period): number {
  const days = getPeriodDays(period)
  const roiDecimal = roi / 100  // 转换为小数
  return (365 / days) * safeLog1p(roiDecimal)
}

/**
 * 计算收益分 (0-85)
 * ReturnScore = 85 * tanh(coeff * I)^exponent
 * 
 * @param roi ROI 百分比
 * @param period 时间段
 */
export function calculateReturnScore(roi: number, period: Period): number {
  const params = ARENA_CONFIG.PARAMS[period]
  const intensity = calculateRoiIntensity(roi, period)
  
  // R0 = tanh(coeff * I)
  const r0 = Math.tanh(params.tanhCoeff * intensity)
  
  // ReturnScore = 85 * R0^exponent
  // 只有正收益才有正分数
  if (r0 <= 0) return 0
  
  const score = ARENA_CONFIG.MAX_RETURN_SCORE * Math.pow(r0, params.roiExponent)
  return clip(score, 0, ARENA_CONFIG.MAX_RETURN_SCORE)
}

/**
 * 计算回撤分 (0-8)
 * DrawdownScore = 8 * clip(1 - MDD/阈值, 0, 1)
 * 
 * @param maxDrawdown 最大回撤百分比（如 20 表示 20%）
 * @param period 时间段
 */
export function calculateDrawdownScore(maxDrawdown: number | null, period: Period): number {
  if (maxDrawdown === null || maxDrawdown === undefined) {
    // 无回撤数据时给予低分（惩罚缺失数据，而非奖励）
    return ARENA_CONFIG.MAX_DRAWDOWN_SCORE * 0.25
  }

  // 归一化：如果 |maxDrawdown| <= 1，认为是小数格式（0.20），需要转换为百分比（20）
  const mddAbs = Math.abs(maxDrawdown)
  const normalizedMdd = mddAbs <= 1 ? mddAbs * 100 : mddAbs

  const threshold = ARENA_CONFIG.PARAMS[period].mddThreshold
  const score = ARENA_CONFIG.MAX_DRAWDOWN_SCORE * clip(1 - normalizedMdd / threshold, 0, 1)
  return clip(score, 0, ARENA_CONFIG.MAX_DRAWDOWN_SCORE)
}

/**
 * 计算稳定分 (0-7)
 * StabilityScore = 7 * clip((WinRate - 0.45) / (上限 - 0.45), 0, 1)
 * 
 * @param winRate 胜率百分比（如 60 表示 60%）
 * @param period 时间段
 */
export function calculateStabilityScore(winRate: number | null, period: Period): number {
  if (winRate === null || winRate === undefined) {
    // 无胜率数据时给予低分（惩罚缺失数据，而非奖励）
    return ARENA_CONFIG.MAX_STABILITY_SCORE * 0.25
  }

  // 归一化：如果 winRate <= 1，认为是小数格式（0.60），需要转换为百分比（60）
  const normalizedWinRate = winRate <= 1 && winRate >= 0 ? winRate * 100 : winRate

  const cap = ARENA_CONFIG.PARAMS[period].winRateCap
  const baseline = ARENA_CONFIG.WIN_RATE_BASELINE

  const score = ARENA_CONFIG.MAX_STABILITY_SCORE * clip((normalizedWinRate - baseline) / (cap - baseline), 0, 1)
  return clip(score, 0, ARENA_CONFIG.MAX_STABILITY_SCORE)
}

/**
 * 检查是否达到入榜门槛
 * 
 * @param pnl 已实现盈亏（USD）
 * @param period 时间段
 */
export function meetsThreshold(pnl: number, period: Period): boolean {
  const threshold = ARENA_CONFIG.PNL_THRESHOLD[period]
  return pnl > threshold
}

// ============================================
// 主要导出函数
// ============================================

/**
 * 计算 Arena Score（单个时间段）
 * 
 * @param input 交易员数据
 * @param period 时间段 ('7D' | '30D' | '90D')
 * @returns Arena Score 结果
 */
export function calculateArenaScore(
  input: TraderScoreInput,
  period: Period
): ArenaScoreResult {
  const { roi, pnl, maxDrawdown, winRate } = input
  
  // 检查入榜门槛
  const meets = meetsThreshold(pnl, period)
  
  // 计算各项分数
  const returnScore = calculateReturnScore(roi, period)
  const drawdownScore = calculateDrawdownScore(maxDrawdown, period)
  const stabilityScore = calculateStabilityScore(winRate, period)
  
  // 总分
  const totalScore = clip(returnScore + drawdownScore + stabilityScore, 0, 100)
  
  return {
    totalScore: Math.round(totalScore * 100) / 100,  // 保留2位小数
    returnScore: Math.round(returnScore * 100) / 100,
    drawdownScore: Math.round(drawdownScore * 100) / 100,
    stabilityScore: Math.round(stabilityScore * 100) / 100,
    meetsThreshold: meets,
  }
}

/**
 * 计算总体分数（个人主页用）
 * OverallScore = 0.70 * Score_90 + 0.25 * Score_30 + 0.05 * Score_7
 * 
 * 缺失数据处理：
 * - 缺 90D：(0.80 * S30 + 0.20 * S7) * 0.85
 * - 只有 7D：S7 * 0.70
 * 
 * @param input 各时间段分数
 * @returns 总体分数 (0-100)
 */
export function calculateOverallScore(input: OverallScoreInput): number {
  const { score7d, score30d, score90d } = input
  
  const has7d = score7d !== null && score7d !== undefined
  const has30d = score30d !== null && score30d !== undefined
  const has90d = score90d !== null && score90d !== undefined
  
  let overall: number
  
  if (has90d && has30d && has7d) {
    // 完整数据：标准加权
    overall = 
      ARENA_CONFIG.OVERALL_WEIGHTS['90D'] * score90d! +
      ARENA_CONFIG.OVERALL_WEIGHTS['30D'] * score30d! +
      ARENA_CONFIG.OVERALL_WEIGHTS['7D'] * score7d!
  } else if (has30d && has7d && !has90d) {
    // 缺 90D：降权惩罚
    overall = (0.80 * score30d! + 0.20 * score7d!) * ARENA_CONFIG.MISSING_90D_PENALTY
  } else if (has7d && !has30d && !has90d) {
    // 只有 7D：强惩罚
    overall = score7d! * ARENA_CONFIG.ONLY_7D_PENALTY
  } else if (has90d && !has30d && !has7d) {
    // 只有 90D
    overall = score90d! * 0.90
  } else if (has90d && has30d && !has7d) {
    // 有 90D 和 30D，缺 7D
    overall = 
      ARENA_CONFIG.OVERALL_WEIGHTS['90D'] * score90d! +
      (ARENA_CONFIG.OVERALL_WEIGHTS['30D'] + ARENA_CONFIG.OVERALL_WEIGHTS['7D']) * score30d!
  } else if (has90d && has7d && !has30d) {
    // 有 90D 和 7D，缺 30D
    overall = 
      ARENA_CONFIG.OVERALL_WEIGHTS['90D'] * score90d! +
      (ARENA_CONFIG.OVERALL_WEIGHTS['30D'] + ARENA_CONFIG.OVERALL_WEIGHTS['7D']) * score7d!
  } else if (has30d && !has7d && !has90d) {
    // 只有 30D
    overall = score30d! * 0.80
  } else {
    // 无数据
    overall = 0
  }
  
  return Math.round(clip(overall, 0, 100) * 100) / 100
}

/**
 * 批量计算 Arena Score（用于排行榜）
 * 
 * @param traders 交易员列表
 * @param period 时间段
 * @returns 带有 arena_score 的交易员列表，已按分数排序
 */
export function rankByArenaScore<T extends TraderScoreInput & { id: string }>(
  traders: T[],
  period: Period
): (T & { arena_score: number; score_details: ArenaScoreResult })[] {
  // 计算分数并过滤
  const scored = traders
    .map(trader => {
      const result = calculateArenaScore(trader, period)
      return {
        ...trader,
        arena_score: result.totalScore,
        score_details: result,
      }
    })
    .filter(t => t.score_details.meetsThreshold) // 过滤未达门槛的
  
  // 按分数降序排序
  scored.sort((a, b) => {
    // 主排序：Arena Score 降序
    if (b.arena_score !== a.arena_score) {
      return b.arena_score - a.arena_score
    }
    // 次排序：回撤小的优先
    const mddA = Math.abs(a.maxDrawdown ?? Infinity)
    const mddB = Math.abs(b.maxDrawdown ?? Infinity)
    return mddA - mddB
  })
  
  return scored
}
