/**
 * Arena Data Pipeline - Calculator Layer
 *
 * 职责：计算派生指标
 * - Arena Score (0-100)
 * - Platform Rank
 * - Trader Type Detection (human/bot)
 */

import {
  StandardTraderData,
  EnrichedTraderData,
  ArenaScoreComponents,
  TraderType,
  ARENA_SCORE_CONFIG,
  CONFIDENCE_MULTIPLIER,
  VALIDATION_BOUNDS,
  TimeWindow,
} from './types'
import { isDexPlatform } from './capabilities'

// =============================================================================
// Main Calculator Class
// =============================================================================

export class PipelineCalculator {
  /**
   * 主入口：计算派生指标并排名
   */
  enrich(traders: StandardTraderData[]): EnrichedTraderData[] {
    if (traders.length === 0) return []

    // 按 platform + window 分组
    const groups = this.groupBy(traders, (t) => `${t.platform}:${t.window}`)
    const results: EnrichedTraderData[] = []

    for (const [_key, group] of Object.entries(groups)) {
      // 计算每个 trader 的分数
      const withScores = group.map((t) => {
        const components = this.calculateArenaScoreComponents(t)
        const arenaScore = this.calculateArenaScore(t, components)

        return {
          ...t,
          arena_score: arenaScore,
          arena_score_components: components,
          trader_type: this.detectTraderType(t),
          sharpe_ratio: null, // 需要历史数据，后续富化阶段计算
          sortino_ratio: null,
          platform_rank: null as number | null,
          enriched_at: new Date(),
        }
      })

      // 排序（Arena Score 降序）
      withScores.sort((a, b) => b.arena_score - a.arena_score)

      // 分配排名
      withScores.forEach((t, index) => {
        t.platform_rank = index + 1
      })

      results.push(...withScores)
    }

    return results
  }

  /**
   * 计算单个交易员的 Arena Score
   */
  calculateArenaScore(
    trader: StandardTraderData,
    components?: ArenaScoreComponents
  ): number {
    const comps = components || this.calculateArenaScoreComponents(trader)
    const baseScore = comps.return_score + comps.pnl_score

    // 应用置信度乘数
    const multiplier = CONFIDENCE_MULTIPLIER[trader.confidence]
    const total = baseScore * multiplier

    return this.clamp(total, VALIDATION_BOUNDS.arena_score.min, VALIDATION_BOUNDS.arena_score.max)
  }

  /**
   * 计算 Arena Score 组件
   */
  calculateArenaScoreComponents(trader: StandardTraderData): ArenaScoreComponents {
    const config = ARENA_SCORE_CONFIG[trader.window]

    // 收益分：60 × tanh(coeff × roi)^exponent
    const returnScore = this.calculateReturnScore(trader.roi_pct, config)

    // PnL 分：40 × tanh(coeff × ln(1 + pnl/base))
    const pnlScore = this.calculatePnlScore(trader.pnl_usd, config)

    return {
      return_score: returnScore,
      pnl_score: pnlScore,
    }
  }

  /**
   * 计算收益分 (0-60)
   */
  private calculateReturnScore(
    roiPct: number | null,
    config: typeof ARENA_SCORE_CONFIG['7d']
  ): number {
    if (roiPct === null || roiPct <= 0) return 0

    // ROI 以百分比输入，除以 100 转为小数
    const roiDecimal = roiPct / 100

    // 60 × tanh(coeff × roi)^exponent
    const score = 60 * Math.pow(Math.tanh(config.tanhCoeff * roiDecimal * 100), config.roiExponent)

    return Math.max(0, Math.min(60, score))
  }

  /**
   * 计算 PnL 分 (0-40)
   */
  private calculatePnlScore(
    pnlUsd: number | null,
    config: typeof ARENA_SCORE_CONFIG['7d']
  ): number {
    if (pnlUsd === null || pnlUsd <= 0) return 0

    // 40 × tanh(coeff × ln(1 + pnl/base))
    const score = 40 * Math.tanh(config.pnlCoeff * Math.log(1 + pnlUsd / config.pnlBase))

    return Math.max(0, Math.min(40, score))
  }

  /**
   * Bot 检测
   *
   * 检测规则（针对 DEX 地址）：
   * 1. 交易次数 > 500 → bot
   * 2. 平均持仓 < 0.5h 且交易 > 100 → bot
   * 3. 胜率 >= 95% 且交易 > 50 → bot（过于完美）
   */
  detectTraderType(trader: StandardTraderData): TraderType {
    // 只检测 DEX 地址
    if (!isDexPlatform(trader.platform)) return null
    if (!trader.trader_id.startsWith('0x')) return null

    const trades = trader.trades_count ?? 0
    const avgHolding = trader.avg_holding_hours
    const winRate = trader.win_rate_pct

    // 规则 1: 高频交易
    if (trades > 500) return 'bot'

    // 规则 2: 极短持仓 + 较多交易
    if (avgHolding !== null && avgHolding < 0.5 && trades > 100) return 'bot'

    // 规则 3: 过于完美的胜率
    if (winRate !== null && winRate >= 95 && trades > 50) return 'bot'

    return null
  }

  /**
   * 计算综合分数（跨时间窗口加权）
   *
   * 权重：90D × 0.70 + 30D × 0.25 + 7D × 0.05
   */
  calculateOverallScore(scores: Record<TimeWindow, number | null>): number | null {
    const weights: Record<TimeWindow, number> = {
      '90d': 0.7,
      '30d': 0.25,
      '7d': 0.05,
    }

    let totalWeight = 0
    let weightedSum = 0

    for (const [window, score] of Object.entries(scores)) {
      if (score !== null) {
        const w = weights[window as TimeWindow]
        weightedSum += score * w
        totalWeight += w
      }
    }

    if (totalWeight === 0) return null
    return weightedSum / totalWeight
  }

  // =============================================================================
  // Helper Methods
  // =============================================================================

  /**
   * 分组函数
   */
  private groupBy<T>(items: T[], keyFn: (item: T) => string): Record<string, T[]> {
    return items.reduce(
      (acc, item) => {
        const key = keyFn(item)
        if (!acc[key]) acc[key] = []
        acc[key].push(item)
        return acc
      },
      {} as Record<string, T[]>
    )
  }

  /**
   * 数值边界限制
   */
  private clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value))
  }
}

// =============================================================================
// Singleton Instance
// =============================================================================

let calculatorInstance: PipelineCalculator | null = null

export function getCalculator(): PipelineCalculator {
  if (!calculatorInstance) {
    calculatorInstance = new PipelineCalculator()
  }
  return calculatorInstance
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * 快速计算 Arena Score（不需要完整 enrichment）
 */
export function quickArenaScore(
  roiPct: number | null,
  pnlUsd: number | null,
  window: TimeWindow = '30d',
  confidence: 'full' | 'partial' | 'minimal' = 'full'
): number {
  const config = ARENA_SCORE_CONFIG[window]

  // 收益分
  let returnScore = 0
  if (roiPct !== null && roiPct > 0) {
    returnScore = 60 * Math.pow(Math.tanh(config.tanhCoeff * roiPct), config.roiExponent)
  }

  // PnL 分
  let pnlScore = 0
  if (pnlUsd !== null && pnlUsd > 0) {
    pnlScore = 40 * Math.tanh(config.pnlCoeff * Math.log(1 + pnlUsd / config.pnlBase))
  }

  // 应用置信度乘数
  const multiplier = CONFIDENCE_MULTIPLIER[confidence]
  const total = (returnScore + pnlScore) * multiplier

  return Math.max(0, Math.min(100, total))
}
