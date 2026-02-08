/**
 * 跟单组合建议算法
 * 根据用户风险偏好推荐分散化的交易员组合
 */
import { round1, round2, moneyMul } from '@/lib/utils/currency'

// ============================================
// 类型定义
// ============================================

export interface TraderForPortfolio {
  trader_id: string
  source: string
  handle: string
  roi: number
  max_drawdown: number | null
  win_rate: number | null
  arena_score: number
  followers: number
  source_type: 'futures' | 'spot' | 'web3'
}

export interface PortfolioTrader {
  trader_id: string
  source: string
  handle: string
  allocation_pct: number      // 建议分配比例 (0-100)
  reason: string              // 推荐理由
  risk_level: 'low' | 'medium' | 'high'
  expected_contribution: {
    roi: number
    drawdown: number
  }
}

export interface PortfolioSuggestion {
  id: string
  name: string
  description: string
  risk_level: 'conservative' | 'balanced' | 'aggressive'
  traders: PortfolioTrader[]
  expected_metrics: {
    roi: number
    max_drawdown: number
    sharpe_ratio: number
  }
  diversification_score: number  // 0-100，越高越分散
  created_at: string
}

export type RiskPreference = 'conservative' | 'balanced' | 'aggressive'

// ============================================
// 配置参数
// ============================================

const PORTFOLIO_CONFIG = {
  // 不同风险偏好的参数（Phase 3 spec thresholds）
  conservative: {
    maxDrawdownThreshold: 10,     // MDD < 10%
    minWinRate: 60,               // WR > 60%
    minArenaScore: 70,            // Score > 70
    traderCount: 5,               // 推荐交易员数量
    maxAllocation: 30,            // 单个交易员最大配比
  },
  balanced: {
    maxDrawdownThreshold: 25,     // MDD < 25%
    minWinRate: 50,               // WR > 50%
    minArenaScore: 50,            // Score > 50
    traderCount: 5,
    maxAllocation: 35,
  },
  aggressive: {
    maxDrawdownThreshold: 100,    // 不限 MDD
    minWinRate: 0,                // 不限 WR，按 ROI 排序
    minArenaScore: 0,             // 不限 Score
    traderCount: 4,
    maxAllocation: 40,
    sortByRoi: true,              // 高风险按 ROI 最高排序
  },
}

// ============================================
// 工具函数
// ============================================

/**
 * 计算两个交易员之间的相关性（简化版）
 * 基于来源类型和收益率相似度
 */
function calculateCorrelation(trader1: TraderForPortfolio, trader2: TraderForPortfolio): number {
  let correlation = 0

  // 相同交易所增加相关性
  if (trader1.source === trader2.source) {
    correlation += 0.3
  }

  // 相同类型增加相关性
  if (trader1.source_type === trader2.source_type) {
    correlation += 0.2
  }

  // ROI 相似度增加相关性
  const roiDiff = Math.abs(trader1.roi - trader2.roi)
  if (roiDiff < 10) {
    correlation += 0.2
  } else if (roiDiff < 25) {
    correlation += 0.1
  }

  // 风险相似度增加相关性
  const dd1 = Math.abs(trader1.max_drawdown || 0)
  const dd2 = Math.abs(trader2.max_drawdown || 0)
  const ddDiff = Math.abs(dd1 - dd2)
  if (ddDiff < 5) {
    correlation += 0.2
  } else if (ddDiff < 10) {
    correlation += 0.1
  }

  return Math.min(correlation, 1)
}

/**
 * 计算组合的多元化得分
 */
function calculateDiversificationScore(traders: TraderForPortfolio[]): number {
  if (traders.length < 2) return 0

  let totalCorrelation = 0
  let pairCount = 0

  for (let i = 0; i < traders.length; i++) {
    for (let j = i + 1; j < traders.length; j++) {
      totalCorrelation += calculateCorrelation(traders[i], traders[j])
      pairCount++
    }
  }

  const avgCorrelation = totalCorrelation / pairCount
  // 相关性越低，分散化得分越高
  return Math.round((1 - avgCorrelation) * 100)
}

/**
 * 判断交易员风险等级
 */
function getTraderRiskLevel(trader: TraderForPortfolio): 'low' | 'medium' | 'high' {
  const drawdown = Math.abs(trader.max_drawdown || 0)
  
  if (drawdown < 10 && (trader.win_rate || 0) >= 55) {
    return 'low'
  } else if (drawdown < 25 && (trader.win_rate || 0) >= 45) {
    return 'medium'
  } else {
    return 'high'
  }
}

/**
 * 生成推荐理由
 */
function generateReason(trader: TraderForPortfolio, config: typeof PORTFOLIO_CONFIG.balanced): string {
  const reasons: string[] = []
  
  if (trader.arena_score >= 60) {
    reasons.push('Arena Score 优秀')
  }
  
  const drawdown = Math.abs(trader.max_drawdown || 0)
  if (drawdown < 10) {
    reasons.push('回撤控制出色')
  } else if (drawdown < config.maxDrawdownThreshold * 0.6) {
    reasons.push('风险控制良好')
  }
  
  if ((trader.win_rate || 0) >= 60) {
    reasons.push('高胜率')
  }
  
  if (trader.followers >= 1000) {
    reasons.push('受欢迎度高')
  }
  
  if (trader.source_type === 'spot') {
    reasons.push('现货交易风险较低')
  } else if (trader.source_type === 'web3') {
    reasons.push('链上交易透明')
  }
  
  return reasons.length > 0 ? reasons.join('、') : '综合表现稳定'
}

// ============================================
// 核心算法
// ============================================

/**
 * 筛选符合条件的交易员
 */
function filterCandidates(
  traders: TraderForPortfolio[],
  preference: RiskPreference
): TraderForPortfolio[] {
  const config = PORTFOLIO_CONFIG[preference]
  
  return traders.filter(trader => {
    const drawdown = Math.abs(trader.max_drawdown || 100)
    const winRate = trader.win_rate || 0
    
    return (
      drawdown <= config.maxDrawdownThreshold &&
      winRate >= config.minWinRate &&
      trader.arena_score >= config.minArenaScore
    )
  })
}

/**
 * 选择最优组合（贪心算法 + 多元化约束）
 */
function selectOptimalTraders(
  candidates: TraderForPortfolio[],
  preference: RiskPreference
): TraderForPortfolio[] {
  const config = PORTFOLIO_CONFIG[preference]
  const selected: TraderForPortfolio[] = []
  const usedSources = new Set<string>()
  const usedSourceTypes = new Set<string>()

  // Aggressive sorts by ROI; others by Arena Score
  const sortByRoi = (PORTFOLIO_CONFIG[preference] as Record<string, unknown>).sortByRoi === true
  const sorted = [...candidates].sort((a, b) =>
    sortByRoi ? b.roi - a.roi : b.arena_score - a.arena_score
  )

  for (const trader of sorted) {
    if (selected.length >= config.traderCount) break

    // 多元化约束：尽量不重复交易所
    // 前 3 个必须来自不同交易所
    if (selected.length < 3 && usedSources.has(trader.source)) {
      continue
    }

    // 尽量包含不同类型
    if (selected.length < 3 && selected.length > 0 && usedSourceTypes.has(trader.source_type)) {
      // 如果没有其他选择，也可以接受
      const remainingDifferentType = sorted.find(
        t => !usedSourceTypes.has(t.source_type) && t.trader_id !== trader.trader_id
      )
      if (remainingDifferentType) {
        continue
      }
    }

    selected.push(trader)
    usedSources.add(trader.source)
    usedSourceTypes.add(trader.source_type)
  }

  // 如果还不够，放宽约束
  if (selected.length < config.traderCount) {
    for (const trader of sorted) {
      if (selected.length >= config.traderCount) break
      if (selected.some(s => s.trader_id === trader.trader_id)) continue
      selected.push(trader)
    }
  }

  return selected
}

/**
 * 计算配比（基于 Arena Score 加权）
 */
function calculateAllocations(
  traders: TraderForPortfolio[],
  preference: RiskPreference
): Map<string, number> {
  const config = PORTFOLIO_CONFIG[preference]
  const allocations = new Map<string, number>()

  const totalScore = traders.reduce((sum, t) => sum + t.arena_score, 0)

  for (const trader of traders) {
    // 基于 Arena Score 计算初始配比
    let allocation = (trader.arena_score / totalScore) * 100

    // 根据风险调整
    const riskLevel = getTraderRiskLevel(trader)
    if (preference === 'conservative') {
      if (riskLevel === 'high') allocation *= 0.7
      if (riskLevel === 'low') allocation *= 1.2
    } else if (preference === 'aggressive') {
      if (riskLevel === 'high') allocation *= 1.1
      if (riskLevel === 'low') allocation *= 0.9
    }

    // 限制最大配比
    allocation = Math.min(allocation, config.maxAllocation)
    allocations.set(trader.trader_id, allocation)
  }

  // 归一化确保总和为 100
  const total = Array.from(allocations.values()).reduce((sum, v) => sum + v, 0)
  for (const [id, value] of allocations) {
    allocations.set(id, Math.round((value / total) * 100))
  }

  return allocations
}

/**
 * 计算组合预期指标
 */
function calculateExpectedMetrics(
  traders: TraderForPortfolio[],
  allocations: Map<string, number>
): { roi: number; max_drawdown: number; sharpe_ratio: number } {
  let weightedRoi = 0
  let weightedDrawdown = 0

  for (const trader of traders) {
    const weight = (allocations.get(trader.trader_id) || 0) / 100
    weightedRoi += trader.roi * weight
    weightedDrawdown += Math.abs(trader.max_drawdown || 0) * weight
  }

  // 简化的夏普率计算（假设无风险利率为 2%）
  const riskFreeRate = 2
  const volatility = weightedDrawdown * 0.5  // 简化估算
  const sharpeRatio = volatility > 0 
    ? (weightedRoi - riskFreeRate) / volatility 
    : 0

  return {
    roi: round1(weightedRoi),
    max_drawdown: round1(weightedDrawdown),
    sharpe_ratio: round2(sharpeRatio),
  }
}

// ============================================
// 主函数
// ============================================

/**
 * 生成跟单组合建议
 */
export function generatePortfolioSuggestion(
  allTraders: TraderForPortfolio[],
  preference: RiskPreference
): PortfolioSuggestion | null {
  // 1. 筛选候选人
  const candidates = filterCandidates(allTraders, preference)
  
  if (candidates.length < 3) {
    return null  // 候选人不足
  }

  // 2. 选择最优组合
  const selectedTraders = selectOptimalTraders(candidates, preference)
  
  if (selectedTraders.length < 3) {
    return null
  }

  // 3. 计算配比
  const allocations = calculateAllocations(selectedTraders, preference)

  // 4. 构建结果
  const config = PORTFOLIO_CONFIG[preference]
  const portfolioTraders: PortfolioTrader[] = selectedTraders.map(trader => ({
    trader_id: trader.trader_id,
    source: trader.source,
    handle: trader.handle,
    allocation_pct: allocations.get(trader.trader_id) || 0,
    reason: generateReason(trader, config),
    risk_level: getTraderRiskLevel(trader),
    expected_contribution: {
      roi: round1(moneyMul(trader.roi, (allocations.get(trader.trader_id) || 0) / 100)),
      drawdown: round1(moneyMul(Math.abs(trader.max_drawdown || 0), (allocations.get(trader.trader_id) || 0) / 100)),
    },
  }))

  const expectedMetrics = calculateExpectedMetrics(selectedTraders, allocations)
  const diversificationScore = calculateDiversificationScore(selectedTraders)

  const nameMap = {
    conservative: '稳健型组合',
    balanced: '均衡型组合',
    aggressive: '进取型组合',
  }

  const descMap = {
    conservative: '优先考虑风险控制，适合稳健型投资者',
    balanced: '平衡收益与风险，适合大多数投资者',
    aggressive: '追求高收益，接受较高波动',
  }

  return {
    id: `portfolio-${preference}-${Date.now()}`,
    name: nameMap[preference],
    description: descMap[preference],
    risk_level: preference,
    traders: portfolioTraders,
    expected_metrics: expectedMetrics,
    diversification_score: diversificationScore,
    created_at: new Date().toISOString(),
  }
}

/**
 * 生成所有风险偏好的组合建议
 */
export function generateAllPortfolioSuggestions(
  allTraders: TraderForPortfolio[]
): PortfolioSuggestion[] {
  const preferences: RiskPreference[] = ['conservative', 'balanced', 'aggressive']
  const suggestions: PortfolioSuggestion[] = []

  for (const preference of preferences) {
    const suggestion = generatePortfolioSuggestion(allTraders, preference)
    if (suggestion) {
      suggestions.push(suggestion)
    }
  }

  return suggestions
}
