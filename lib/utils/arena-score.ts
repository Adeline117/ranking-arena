import { round2 } from '@/lib/utils/currency'

/**
 * Arena Score V3 计算模块
 *
 * 评分结构：收益分（0-60）+ PnL 分（0-40）= 总分（0-100）
 *
 * V3 变更：移除回撤分和稳定分，只保留 ROI 和 PnL 两个维度。
 * PnL 参数重新标定，基于真实数据分布（中位数对应约13分）。
 *
 * 目标分布：
 * - 中位数交易员：~30 分（7D）/ ~25 分（30D/90D）
 * - p75：~60 分
 * - p90：~80 分
 * - 顶尖 p99：~95-100 分
 */

// ============================================
// 类型定义
// ============================================

export type Period = '7D' | '30D' | '90D'

/**
 * 分数置信度：标记计算时数据的完整程度
 * - 'full': win_rate 和 max_drawdown 都有真实数据
 * - 'partial': 其中一项缺失，使用了默认中位值
 * - 'minimal': 两项都缺失，使用了默认中位值
 */
export type ScoreConfidence = 'full' | 'partial' | 'minimal'

/** @deprecated Use UnifiedTrader from '@/lib/types/unified-trader' for application code */
export interface TraderScoreInput {
  roi: number          // ROI（百分比，如 25% = 25）
  pnl: number          // 已实现盈亏（USD）
  maxDrawdown: number | null  // 最大回撤（百分比，如 20% = 20）
  winRate: number | null      // 胜率（百分比，如 60% = 60）
  source?: string      // 数据来源（用于 trust weight）
}

export interface ArenaScoreResult {
  totalScore: number      // 总分 (0-100)
  returnScore: number     // 收益分 (0-70)
  pnlScore: number        // PnL 分 (0-15)
  drawdownScore: number   // 回撤分 (0-8)
  stabilityScore: number  // 稳定分 (0-7)
  scoreConfidence: ScoreConfidence  // 数据完整性标记
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
  
  // PnL 评分参数（V3: 基于真实数据分布标定，中位数≈13分，p90≈35分）
  PNL_PARAMS: {
    '7D':  { base: 300,  coeff: 0.42 },
    '30D': { base: 600,  coeff: 0.30 },
    '90D': { base: 650,  coeff: 0.27 },
  },

  // 分数权重（V3：只保留 ROI + PnL，总分 100）
  MAX_RETURN_SCORE: 60,
  MAX_PNL_SCORE: 40,
  MAX_DRAWDOWN_SCORE: 0,   // V3 已移除
  MAX_STABILITY_SCORE: 0,  // V3 已移除
  
  // 总体分数权重
  OVERALL_WEIGHTS: {
    '90D': 0.70,
    '30D': 0.25,
    '7D': 0.05,
  },
  
  // 缺失数据默认中位值
  DEFAULTS: {
    WIN_RATE: 50,       // 中位胜率（%）
    MAX_DRAWDOWN: -20,  // 中位最大回撤（%）
  },

  // ROI 合理性上限（超过此值的 ROI 会被 cap）
  // 防止异常高 ROI（如 Hyperliquid 百万级%）垄断排行榜
  ROI_CAP: 10000,  // 10000% = 100x，超过此值 ROI 按 10000% 计算 score

  // 数据完整性惩罚乘数（应用于总分）
  // 'full': 所有字段完整 → 1.0（无惩罚）
  // 'partial': 缺少 win_rate 或 max_drawdown → 0.92
  // 'minimal': 两者都缺 → 0.80
  CONFIDENCE_MULTIPLIER: {
    full: 1.0,
    partial: 0.92,
    minimal: 0.80,
  },

  // 缺失数据惩罚
  MISSING_90D_PENALTY: 0.85,
  ONLY_7D_PENALTY: 0.70,

  // 动量因子参数
  MOMENTUM_MAX_BONUS: 2.5,    // 最大加分（7D远超30D时）
  MOMENTUM_MAX_PENALTY: 1,    // 最大扣分（7D远低于30D时）

  // === 排行榜稳定性参数 ===

  // 置信度防抖：数据完整度变化后缓冲 2 小时
  CONFIDENCE_DEBOUNCE_HOURS: 2,
} as const

// ============================================
// 工具函数
// ============================================

/**
 * Wilson Score Lower Bound — penalizes small sample sizes.
 * Used instead of raw confidence multiplier tiers for more granular
 * confidence scoring based on data completeness.
 * Reference: https://www.evanmiller.org/how-not-to-sort-by-average-rating.html
 *
 * @param positiveSignals Number of available (non-null) metrics
 * @param totalSignals Total possible metrics
 * @param z Z-score for confidence interval (default 1.96 = 95%)
 */
export function wilsonLowerBound(positiveSignals: number, totalSignals: number, z: number = 1.96): number {
  if (totalSignals === 0) return 0
  const phat = positiveSignals / totalSignals
  const denominator = 1 + z * z / totalSignals
  const centre = phat + z * z / (2 * totalSignals)
  const spread = z * Math.sqrt((phat * (1 - phat) + z * z / (4 * totalSignals)) / totalSignals)
  return (centre - spread) / denominator
}

/**
 * Compute Wilson-based confidence multiplier from metric availability.
 * Replaces the hard-coded CONFIDENCE_MULTIPLIER tiers with a smooth curve.
 *
 * Checks 5 signals: roi, pnl, maxDrawdown, winRate, sharpeRatio.
 * Output range: [0.3, 1.0] — never fully zeros out a score.
 */
export function wilsonConfidenceMultiplier(
  roi: number | null | undefined,
  pnl: number | null | undefined,
  maxDrawdown: number | null | undefined,
  winRate: number | null | undefined,
  sharpeRatio: number | null | undefined,
): number {
  const signals = [roi, pnl, maxDrawdown, winRate, sharpeRatio]
  const available = signals.filter(v => v != null).length
  const wilson = wilsonLowerBound(available, 5, 1.96)
  // Blend: minimum 0.3 (never fully zero out), max 1.0
  return 0.3 + 0.7 * wilson
}

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
 * 计算收益分 (0-70)
 * ReturnScore = 70 * tanh(coeff * I)^exponent
 * 
 * ROI 会被 cap 到 ARENA_CONFIG.ROI_CAP 以防止异常值
 * （如 Hyperliquid 百万级 ROI）垄断排行榜。
 * 
 * @param roi ROI 百分比
 * @param period 时间段
 */
export function calculateReturnScore(roi: number, period: Period): number {
  if (!Number.isFinite(roi)) return 0
  const params = ARENA_CONFIG.PARAMS[period]

  // Cap ROI to prevent extreme values from dominating
  const cappedRoi = Math.min(roi, ARENA_CONFIG.ROI_CAP)
  
  const intensity = calculateRoiIntensity(cappedRoi, period)
  
  // R0 = tanh(coeff * I)
  const r0 = Math.tanh(params.tanhCoeff * intensity)
  
  // ReturnScore = 70 * R0^exponent
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
  // 缺失或 0 时使用默认中位值（-20%）
  // DD=0 不代表零回撤，通常是数据缺失被存为 0，不应获得满分
  const effectiveMdd = (maxDrawdown === null || maxDrawdown === undefined || maxDrawdown === 0)
    ? ARENA_CONFIG.DEFAULTS.MAX_DRAWDOWN
    : maxDrawdown

  // 归一化：如果 |maxDrawdown| <= 1，认为是小数格式（0.20），需要转换为百分比（20）
  const mddAbs = Math.abs(effectiveMdd)
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
  // 缺失时使用默认中位值（50%）而非给予固定中等分数
  const effectiveWinRate = (winRate === null || winRate === undefined)
    ? ARENA_CONFIG.DEFAULTS.WIN_RATE
    : winRate

  // 归一化：如果 winRate <= 1，认为是小数格式（0.60），需要转换为百分比（60）
  const normalizedWinRate = effectiveWinRate <= 1 && effectiveWinRate >= 0 ? effectiveWinRate * 100 : effectiveWinRate

  const cap = ARENA_CONFIG.PARAMS[period].winRateCap
  const baseline = ARENA_CONFIG.WIN_RATE_BASELINE

  const score = ARENA_CONFIG.MAX_STABILITY_SCORE * clip((normalizedWinRate - baseline) / (cap - baseline), 0, 1)
  return clip(score, 0, ARENA_CONFIG.MAX_STABILITY_SCORE)
}

/**
 * 计算 PnL 分 (0-15)
 * PnlScore = 15 * clip(tanh(coeff * ln(1 + pnl / base)), 0, 1)
 *
 * 使用 log-tanh 压缩：
 * - 小额 PnL（$1K）获得少量分数
 * - 大额 PnL（$100K+）获得高分但有递减效应
 * - 负 PnL 或缺失 PnL → 0 分
 *
 * @param pnl 已实现盈亏（USD）
 * @param period 时间段
 */
export function calculatePnlScore(pnl: number | null, period: Period): number {
  if (pnl === null || pnl === undefined || !Number.isFinite(pnl) || pnl <= 0) return 0

  const params = ARENA_CONFIG.PNL_PARAMS[period]
  const logArg = 1 + pnl / params.base
  if (logArg <= 0) return 0

  const score = ARENA_CONFIG.MAX_PNL_SCORE * Math.tanh(params.coeff * Math.log(logArg))
  return clip(score, 0, ARENA_CONFIG.MAX_PNL_SCORE)
}

/**
 * 置信度防抖：数据完整度变化后缓冲一段时间
 *
 * 当 MDD/WR 间歇性从有变无时，不立即降低置信度乘数，
 * 给 CONFIDENCE_DEBOUNCE_HOURS 小时缓冲。
 *
 * @param currentConfidence 当前置信度
 * @param fullConfidenceAt 上次 full 置信度时间（ISO string）
 * @param debounceHours 缓冲小时数（默认 8）
 */
export function debouncedConfidence(
  currentConfidence: ScoreConfidence,
  fullConfidenceAt: string | null | undefined,
  debounceHours: number = ARENA_CONFIG.CONFIDENCE_DEBOUNCE_HOURS
): ScoreConfidence {
  if (currentConfidence === 'full') return 'full'
  if (!fullConfidenceAt) return currentConfidence

  const elapsed = Date.now() - new Date(fullConfidenceAt).getTime()
  if (elapsed < debounceHours * 3600 * 1000) return 'full'
  return currentConfidence
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
/**
 * 判断分数置信度
 * @param maxDrawdown 原始 MDD 输入（null 表示缺失）
 * @param winRate 原始胜率输入（null 表示缺失）
 */
export function getScoreConfidence(
  maxDrawdown: number | null | undefined,
  winRate: number | null | undefined,
): ScoreConfidence {
  // DD=0 也视为缺失数据（通常是未提供而非真正零回撤）
  const hasMdd = maxDrawdown !== null && maxDrawdown !== undefined && maxDrawdown !== 0
  // WR=0 也视为缺失数据（大多数交易所在没有数据时报 0%，而非真正 0% 胜率）
  const hasWr = winRate !== null && winRate !== undefined && winRate !== 0

  if (hasMdd && hasWr) return 'full'
  if (hasMdd || hasWr) return 'partial'
  return 'minimal'
}

export function calculateArenaScore(
  input: TraderScoreInput,
  period: Period
): ArenaScoreResult {
  const { roi, pnl } = input

  // V3: 只计算 ROI 和 PnL 两个维度
  const returnScore = calculateReturnScore(roi, period)
  const pnlScore = calculatePnlScore(pnl, period)

  const totalScore = clip(returnScore + pnlScore, 0, 100)

  return {
    totalScore: round2(totalScore),
    returnScore: round2(returnScore),
    pnlScore: round2(pnlScore),
    drawdownScore: 0,      // V3 已移除
    stabilityScore: 0,     // V3 已移除
    scoreConfidence: 'full',  // V3 不再区分置信度
  }
}

/**
 * 计算动量加分
 * 当交易员近期（7D）表现优于长期（30D），获得正向加分；反之扣分。
 *
 * 公式: clip(score7D / score30D - 1, -0.2, 0.5) * 5
 * 范围: -MOMENTUM_MAX_PENALTY 到 +MOMENTUM_MAX_BONUS（即 -1 到 +2.5）
 *
 * @param score7d 7天分数
 * @param score30d 30天分数
 * @returns 动量加分（可为负数）
 */
export function calculateMomentumBonus(
  score7d: number | null,
  score30d: number | null,
): number {
  if (score7d === null || score7d === undefined) return 0
  if (score30d === null || score30d === undefined) return 0
  if (score30d === 0) return 0

  const ratio = score7d / score30d - 1
  const clipped = clip(ratio, -0.2, 0.5)
  const bonus = clipped * 5
  return clip(bonus, -ARENA_CONFIG.MOMENTUM_MAX_PENALTY, ARENA_CONFIG.MOMENTUM_MAX_BONUS)
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

  // 动量加分：近期表现优于长期时加分，反之扣分
  const momentum = calculateMomentumBonus(score7d ?? null, score30d ?? null)
  overall += momentum

  return round2(clip(overall, 0, 100))
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
  // 计算分数
  const scored = traders
    .map(trader => {
      const result = calculateArenaScore(trader, period)
      return {
        ...trader,
        arena_score: result.totalScore,
        score_details: result,
      }
    })

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

// ============================================
// Arena Score V3 — Three-Dimension Percentile-Based Scoring
// ============================================

/**
 * Arena Score V3 权重配置（三维度体系）
 *
 * 收益能力 (Profitability)  35%: ROI(20%) + Alpha(15%)
 * 风险控制 (Risk Control)   40%: MaxDrawdown(20%) + Sortino(10%) + Calmar(10%)
 * 执行质量 (Execution)      25%: WinRate(15%) + ProfitLossRatio(10%)
 *
 * 归一化方式：分位数排名（0-100 within peer group）
 * 多时间窗口加权：7D×0.20 + 30D×0.45 + 90D×0.35
 *
 * 数据缺失处理：
 *   full:         ROI+回撤+胜率齐全 → 正常评分
 *   partial:      缺Sortino/Calmar → 扣5分，权重重分配
 *   minimal:      只有ROI → 扣15分，上限60
 *   insufficient: 无ROI → 不评分
 */

export {
  calculateArenaScoreV3,
  calculateMultiWindowScore,
  buildPeerContext,
  percentileRank,
  detectCompleteness,
} from '@/lib/scoring/arena-score-v3'

export type {
  ArenaScoreV3Input,
  ArenaScoreV3Result,
  PercentileContext,
  MultiWindowInput,
  DataCompleteness,
} from '@/lib/scoring/arena-score-v3'

/** @deprecated Use UnifiedTrader from '@/lib/types/unified-trader' for application code */
export interface TraderScoreInputV3 extends TraderScoreInput {
  alpha: number | null
  sortinoRatio: number | null
  calmarRatio: number | null
  maxConsecutiveWins: number | null
  maxConsecutiveLosses: number | null
}

// Legacy V3 result for backward compatibility
export interface ArenaScoreV3LegacyResult {
  totalScore: number
  returnScore: number
  pnlScore: number
  drawdownScore: number
  stabilityScore: number
  alphaScore: number
  riskAdjustedScore: number
  consistencyScore: number
  scoreConfidence: ScoreConfidence
}

/**
 * Legacy calculateArenaScoreV3 for backward compatibility with cron job.
 * Wraps new percentile-based V3 with synthetic percentile context.
 * @deprecated Use calculateArenaScoreV3 from lib/scoring/arena-score-v3 with real peer data.
 */
export function calculateArenaScoreV3Legacy(
  input: TraderScoreInputV3,
  _period: Period
): ArenaScoreV3LegacyResult {
  // For backward compat: use fixed-threshold scoring (not percentile)
  // to avoid breaking existing cron until peer data is available
  const { roi, pnl, maxDrawdown, winRate, alpha, sortinoRatio, calmarRatio } = input
  const scoreConfidence = getScoreConfidence(maxDrawdown, winRate)

  // Simple threshold-based scoring (legacy behavior)
  const returnScore = calculateReturnScore(Math.min(roi, ARENA_CONFIG.ROI_CAP), _period) * (55 / 70)
  const pnlScore = calculatePnlScore(pnl, _period) * (12 / 15)
  const drawdownScore = calculateDrawdownScore(maxDrawdown, _period)
  const stabilityScore = calculateStabilityScore(winRate, _period) * (5 / 7)

  let alphaScore = 0
  if (alpha != null && alpha > 0) alphaScore = clip(5 * Math.min(1, alpha / 10), 0, 5)

  let riskAdjustedScore = 0
  if (sortinoRatio != null && sortinoRatio > 0)
    riskAdjustedScore += 7 * Math.min(1, sortinoRatio / 2)
  if (calmarRatio != null && calmarRatio > 0)
    riskAdjustedScore += 3 * Math.min(1, calmarRatio / 2)

  const consistencyScore = 2.5 // neutral default

  const rawTotal = returnScore + pnlScore + drawdownScore + stabilityScore +
                   alphaScore + riskAdjustedScore + consistencyScore
  // Wilson Score confidence: smooth curve based on metric availability (replaces hard-coded tiers)
  const confidenceMultiplier = wilsonConfidenceMultiplier(
    roi, pnl, maxDrawdown, winRate, sortinoRatio ?? calmarRatio
  )
  const totalScore = clip(rawTotal * confidenceMultiplier, 0, 100)

  return {
    totalScore: round2(totalScore),
    returnScore: round2(returnScore),
    pnlScore: round2(pnlScore),
    drawdownScore: round2(drawdownScore),
    stabilityScore: round2(stabilityScore),
    alphaScore: round2(alphaScore),
    riskAdjustedScore: round2(riskAdjustedScore),
    consistencyScore: round2(consistencyScore),
    scoreConfidence,
  }
}
