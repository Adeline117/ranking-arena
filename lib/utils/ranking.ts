/**
 * 交易员排名算法
 * 提供风险调整后的排名计算
 */

export interface TraderRankingData {
  id: string
  roi: number
  pnl: number
  win_rate: number | null
  max_drawdown: number | null
  trades_count: number | null
  source: string
}

export interface RankedTrader extends TraderRankingData {
  rank: number
  risk_adjusted_score: number
  stability_score: number
  is_suspicious: boolean
  suspicion_reasons: string[]
}

// ============================================
// 排名配置
// ============================================

export const RankingConfig = {
  // PnL 最低门槛（低于此值不计入排行）
  MIN_PNL: 1000,
  
  // ROI 异常值阈值（超过此值标记为可疑）
  SUSPICIOUS_ROI_THRESHOLD: 500,
  
  // 最大回撤最小值（用于避免除零）
  MIN_DRAWDOWN: 10,
  
  // 权重配置
  WEIGHTS: {
    ROI: 0.4,           // ROI 权重
    RISK_ADJUSTED: 0.3, // 风险调整收益权重
    STABILITY: 0.2,     // 稳定性权重
    VOLUME: 0.1,        // 交易量/次数权重
  },
  
  // 稳定性计算配置
  STABILITY: {
    WIN_RATE_WEIGHT: 0.5,     // 胜率在稳定性中的权重
    DRAWDOWN_WEIGHT: 0.3,     // 回撤在稳定性中的权重
    TRADES_WEIGHT: 0.2,       // 交易次数在稳定性中的权重
    MIN_TRADES: 10,           // 最低交易次数
    IDEAL_TRADES: 100,        // 理想交易次数
  },
} as const

// ============================================
// 核心计算函数
// ============================================

/**
 * 计算风险调整收益 (Risk-Adjusted Return)
 * 公式: ROI / max(Drawdown, MIN_DRAWDOWN)
 */
export function calculateRiskAdjustedReturn(roi: number, maxDrawdown: number | null): number {
  const effectiveDrawdown = Math.max(Math.abs(maxDrawdown || 0), RankingConfig.MIN_DRAWDOWN)
  return roi / effectiveDrawdown
}

/**
 * 计算稳定性得分 (0-100)
 * 综合考虑胜率、回撤和交易次数
 */
export function calculateStabilityScore(
  winRate: number | null,
  maxDrawdown: number | null,
  tradesCount: number | null
): number {
  const { WIN_RATE_WEIGHT, DRAWDOWN_WEIGHT, TRADES_WEIGHT, MIN_TRADES, IDEAL_TRADES } = RankingConfig.STABILITY
  
  // 胜率得分 (0-100)
  const winRateScore = winRate != null ? Math.min(winRate, 100) : 50

  // 回撤得分 (0-100)，回撤越小得分越高
  const drawdownScore = maxDrawdown != null 
    ? Math.max(0, 100 - Math.abs(maxDrawdown)) 
    : 50

  // 交易次数得分 (0-100)
  const trades = tradesCount || 0
  const tradesScore = trades >= IDEAL_TRADES 
    ? 100 
    : trades < MIN_TRADES 
      ? (trades / MIN_TRADES) * 50 
      : 50 + ((trades - MIN_TRADES) / (IDEAL_TRADES - MIN_TRADES)) * 50

  return (
    winRateScore * WIN_RATE_WEIGHT +
    drawdownScore * DRAWDOWN_WEIGHT +
    tradesScore * TRADES_WEIGHT
  )
}

/**
 * 检测异常数据
 */
export function detectSuspiciousTrader(trader: TraderRankingData): {
  isSuspicious: boolean
  reasons: string[]
} {
  const reasons: string[] = []

  // ROI 过高
  if (Math.abs(trader.roi) > RankingConfig.SUSPICIOUS_ROI_THRESHOLD) {
    reasons.push(`ROI 异常高 (${trader.roi.toFixed(2)}%)`)
  }

  // PnL 过低但 ROI 过高
  if (trader.pnl < RankingConfig.MIN_PNL && trader.roi > 100) {
    reasons.push(`低 PnL ($${trader.pnl.toFixed(0)}) 配合高 ROI`)
  }

  // 零回撤但高 ROI（可能数据不准）
  if ((trader.max_drawdown === 0 || trader.max_drawdown === null) && trader.roi > 50) {
    reasons.push('零回撤配合高 ROI')
  }

  // 极少交易次数但高 ROI
  if (trader.trades_count != null && trader.trades_count < 5 && trader.roi > 100) {
    reasons.push(`极少交易 (${trader.trades_count} 次) 配合高 ROI`)
  }

  return {
    isSuspicious: reasons.length > 0,
    reasons,
  }
}

/**
 * 计算综合排名得分
 */
export function calculateRankingScore(trader: TraderRankingData): number {
  const { WEIGHTS } = RankingConfig

  // 1. 基础 ROI 得分（归一化）
  const roiScore = Math.max(0, trader.roi) / 100 // 假设 100% ROI 为满分基准

  // 2. 风险调整收益得分
  const riskAdjusted = calculateRiskAdjustedReturn(trader.roi, trader.max_drawdown)
  const riskAdjustedScore = Math.max(0, riskAdjusted) / 10 // 归一化

  // 3. 稳定性得分
  const stabilityScore = calculateStabilityScore(
    trader.win_rate,
    trader.max_drawdown,
    trader.trades_count
  ) / 100 // 归一化到 0-1

  // 4. 交易量得分（使用交易次数作为代理）
  const volumeScore = trader.trades_count 
    ? Math.min(trader.trades_count / RankingConfig.STABILITY.IDEAL_TRADES, 1)
    : 0.5

  // 综合得分
  return (
    roiScore * WEIGHTS.ROI +
    riskAdjustedScore * WEIGHTS.RISK_ADJUSTED +
    stabilityScore * WEIGHTS.STABILITY +
    volumeScore * WEIGHTS.VOLUME
  ) * 100
}

// ============================================
// 排名函数
// ============================================

/**
 * 对交易员列表进行排名
 * 
 * 排名规则（优先级从高到低）：
 * 1. 过滤 PnL 低于门槛的交易员
 * 2. 标记可疑数据（但不排除）
 * 3. 按风险调整后的综合得分排序
 * 4. 得分相同时，按回撤小的优先
 * 5. 回撤也相同时，按交易次数多的优先
 */
export function rankTraders(traders: TraderRankingData[]): RankedTrader[] {
  // 过滤低 PnL 交易员（Bybit 的 PnL 是跟单者盈亏，不适用）
  const validTraders = traders.filter(t => 
    t.source === 'bybit' || t.pnl >= RankingConfig.MIN_PNL
  )

  // 计算每个交易员的排名数据
  const tradersWithScores = validTraders.map(trader => {
    const riskAdjustedScore = calculateRiskAdjustedReturn(trader.roi, trader.max_drawdown)
    const stabilityScore = calculateStabilityScore(
      trader.win_rate,
      trader.max_drawdown,
      trader.trades_count
    )
    const { isSuspicious, reasons } = detectSuspiciousTrader(trader)

    return {
      ...trader,
      risk_adjusted_score: riskAdjustedScore,
      stability_score: stabilityScore,
      is_suspicious: isSuspicious,
      suspicion_reasons: reasons,
      _composite_score: calculateRankingScore(trader),
    }
  })

  // 排序
  tradersWithScores.sort((a, b) => {
    // 主排序：综合得分（可疑数据降权）
    const aScore = a._composite_score * (a.is_suspicious ? 0.5 : 1)
    const bScore = b._composite_score * (b.is_suspicious ? 0.5 : 1)
    
    if (bScore !== aScore) return bScore - aScore

    // 次排序：回撤小的优先
    const mddA = Math.abs(a.max_drawdown ?? Infinity)
    const mddB = Math.abs(b.max_drawdown ?? Infinity)
    if (mddA !== mddB) return mddA - mddB

    // 再次排序：交易次数多的优先
    const tradesA = a.trades_count ?? 0
    const tradesB = b.trades_count ?? 0
    return tradesB - tradesA
  })

  // 添加排名
  return tradersWithScores.map((trader, index) => ({
    id: trader.id,
    roi: trader.roi,
    pnl: trader.pnl,
    win_rate: trader.win_rate,
    max_drawdown: trader.max_drawdown,
    trades_count: trader.trades_count,
    source: trader.source,
    rank: index + 1,
    risk_adjusted_score: trader.risk_adjusted_score,
    stability_score: trader.stability_score,
    is_suspicious: trader.is_suspicious,
    suspicion_reasons: trader.suspicion_reasons,
  }))
}

/**
 * 简化版排名（保持与原有排序逻辑兼容）
 * 用于需要简单排序的场景
 */
export function simpleRankTraders(traders: TraderRankingData[]): TraderRankingData[] {
  // 过滤低 PnL
  const validTraders = traders.filter(t => 
    t.source === 'bybit' || t.pnl >= RankingConfig.MIN_PNL
  )

  // 按 ROI 降序，回撤升序，交易次数降序
  return [...validTraders].sort((a, b) => {
    // 1. ROI 降序
    if (b.roi !== a.roi) return b.roi - a.roi
    
    // 2. 回撤小的靠前
    const mddA = Math.abs(a.max_drawdown ?? Infinity)
    const mddB = Math.abs(b.max_drawdown ?? Infinity)
    if (mddA !== mddB) return mddA - mddB
    
    // 3. 交易次数多的靠前
    const tradesA = a.trades_count ?? 0
    const tradesB = b.trades_count ?? 0
    return tradesB - tradesA
  })
}
