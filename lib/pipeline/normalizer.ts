/**
 * Arena Data Pipeline - Normalizer Layer
 *
 * 职责：将原始 API 数据标准化为统一格式
 * - ROI: 全部转为百分比 (25.5 = 25.5%)
 * - PnL: 全部转为 USD
 * - Win Rate: 全部转为百分比 (0-100)
 * - Max Drawdown: 全部转为百分比 (0-100)
 */

import {
  RawFetchResult,
  StandardTraderData,
  TimeWindow,
  Confidence,
  VALIDATION_BOUNDS,
} from './types'
import { getPlatformCapabilities, PlatformCapabilities } from './capabilities'

// =============================================================================
// Main Normalizer Class
// =============================================================================

export class PipelineNormalizer {
  /**
   * 主入口：标准化原始采集数据
   */
  normalize(raw: RawFetchResult): StandardTraderData[] {
    const capabilities = getPlatformCapabilities(raw.platform)
    const window = this.normalizeWindow(raw.window)

    return raw.raw_traders
      .map((trader) => {
        try {
          return this.normalizeTrader(
            raw.platform,
            trader.trader_id,
            trader.raw_data,
            window,
            capabilities
          )
        } catch (error) {
          console.warn(
            `[Normalizer] Failed to normalize trader ${trader.trader_id} on ${raw.platform}:`,
            error
          )
          return null
        }
      })
      .filter((t): t is StandardTraderData => t !== null)
  }

  /**
   * 标准化单个交易员数据
   */
  private normalizeTrader(
    platform: string,
    traderId: string,
    data: Record<string, unknown>,
    window: TimeWindow,
    caps: PlatformCapabilities
  ): StandardTraderData {
    // 核心指标标准化
    const roi = this.normalizeRoi(data, caps)
    const pnl = this.normalizePnl(data, caps)
    const winRate = this.normalizeWinRate(data)
    const maxDrawdown = this.normalizeMaxDrawdown(data)

    return {
      // Identity
      platform,
      trader_id: traderId,
      display_name: this.extractDisplayName(data),
      avatar_url: this.extractAvatarUrl(data),

      // Core Metrics (标准化后)
      roi_pct: roi,
      pnl_usd: pnl,
      win_rate_pct: winRate,
      max_drawdown_pct: maxDrawdown,

      // Social (CEX only)
      followers: caps.fields.followers
        ? this.extractNumber(data, 'followers', 'followerCount', 'follower_count')
        : null,
      copiers: caps.fields.copiers
        ? this.extractNumber(data, 'copiers', 'copyCount', 'copy_count', 'copier_count')
        : null,
      aum_usd: caps.fields.aum
        ? this.extractNumber(data, 'aum', 'assets', 'totalAssets', 'total_assets')
        : null,

      // Activity
      trades_count: this.extractNumber(
        data,
        'trades',
        'tradesCount',
        'trades_count',
        'closedCount',
        'closed_count',
        'tradeCount'
      ),
      avg_holding_hours: this.extractNumber(
        data,
        'avgHoldingHours',
        'avg_holding_hours',
        'averageHoldingTime'
      ),

      // Metadata
      window,
      data_source: 'api',
      confidence: this.determineConfidence(roi, pnl, winRate, maxDrawdown, caps),
      normalized_at: new Date(),
    }
  }

  // =============================================================================
  // ROI Normalization
  // =============================================================================

  /**
   * ROI 标准化（处理三种格式）
   *
   * 格式类型:
   * 1. percentage: API 返回 25.5 表示 25.5%
   * 2. decimal: API 返回 0.255 表示 25.5%
   * 3. needs_detection: 需要智能检测（Hyperliquid）
   */
  private normalizeRoi(
    data: Record<string, unknown>,
    caps: PlatformCapabilities
  ): number | null {
    // 尝试提取 ROI 值
    let raw = this.extractNumber(
      data,
      'roi',
      'value',
      'roi_pct',
      'roiPercent',
      'returnRate',
      'return_rate',
      'pnlRoe'
    )

    // 如果没有直接的 ROI 字段，尝试从 windowPerformances 提取（Hyperliquid）
    if (raw === null && 'windowPerformances' in data) {
      raw = this.extractFromWindowPerformances(data, 'roi')
    }

    // 如果仍然没有，尝试计算 ROI（GMX: pnl / capital）
    if (raw === null && !caps.fields.roi) {
      const pnl = this.extractNumber(data, 'realizedPnl', 'pnl', 'totalPnl')
      const capital = this.extractNumber(
        data,
        'maxCapital',
        'accountValue',
        'depositAmount',
        'initialDeposit'
      )
      if (pnl !== null && capital !== null && capital > 0) {
        // 如果 PnL 是 wei 格式，需要先转换
        const pnlUsd =
          caps.format.pnl_unit === 'wei'
            ? pnl / Math.pow(10, caps.format.pnl_decimals || 18)
            : pnl
        const capitalUsd =
          caps.format.pnl_unit === 'wei'
            ? capital / Math.pow(10, caps.format.pnl_decimals || 18)
            : capital
        raw = (pnlUsd / capitalUsd) * 100
      }
    }

    if (raw === null) return null

    // 根据平台格式处理
    let roi: number
    switch (caps.format.roi_format) {
      case 'percentage':
        // 已是百分比，直接使用
        roi = raw
        break

      case 'decimal':
        // 小数转百分比
        roi = raw * 100
        break

      case 'needs_detection':
        // 智能检测（Hyperliquid 等）
        // 规则：如果绝对值 <= 10，可能是小数（表示 -1000% 到 +1000%）
        if (Math.abs(raw) <= 10) {
          roi = raw * 100
        } else {
          roi = raw
        }
        break

      default:
        roi = raw
    }

    // 边界限制
    return this.clamp(roi, VALIDATION_BOUNDS.roi_pct.min, VALIDATION_BOUNDS.roi_pct.max)
  }

  // =============================================================================
  // PnL Normalization
  // =============================================================================

  /**
   * PnL 标准化 - 统一转为 USD
   */
  private normalizePnl(
    data: Record<string, unknown>,
    caps: PlatformCapabilities
  ): number | null {
    let raw = this.extractNumber(
      data,
      'pnl',
      'realizedPnl',
      'totalPnl',
      'profit',
      'netProfit',
      'cumulativePnl'
    )

    // 尝试从 windowPerformances 提取（Hyperliquid）
    if (raw === null && 'windowPerformances' in data) {
      raw = this.extractFromWindowPerformances(data, 'pnl')
    }

    if (raw === null) return null

    // 单位转换
    switch (caps.format.pnl_unit) {
      case 'usd':
        return raw

      case 'wei':
        const decimals = caps.format.pnl_decimals || 18
        return raw / Math.pow(10, decimals)

      case 'native_token':
        // TODO: 需要价格转换，暂时返回原值
        console.warn(
          `[Normalizer] native_token PnL conversion not implemented for platform`
        )
        return raw

      default:
        return raw
    }
  }

  // =============================================================================
  // Win Rate & Max Drawdown
  // =============================================================================

  /**
   * Win Rate 标准化
   * 输出: 0-100 的百分比
   */
  private normalizeWinRate(data: Record<string, unknown>): number | null {
    const raw = this.extractNumber(
      data,
      'winRate',
      'win_rate',
      'winRatio',
      'win_ratio',
      'successRate'
    )
    if (raw === null) return null

    // 如果值 <= 1，可能是小数格式
    let winRate = raw
    if (raw <= 1) {
      winRate = raw * 100
    }

    return this.clamp(
      winRate,
      VALIDATION_BOUNDS.win_rate_pct.min,
      VALIDATION_BOUNDS.win_rate_pct.max
    )
  }

  /**
   * Max Drawdown 标准化
   * 输出: 0-100 的百分比（正数）
   */
  private normalizeMaxDrawdown(data: Record<string, unknown>): number | null {
    const raw = this.extractNumber(
      data,
      'maxDrawdown',
      'max_drawdown',
      'mdd',
      'maxDrawdownRate',
      'drawdown'
    )
    if (raw === null) return null

    // 取绝对值（有些 API 返回负数）
    let mdd = Math.abs(raw)

    // 如果值 <= 1，可能是小数格式
    if (mdd <= 1) {
      mdd = mdd * 100
    }

    return this.clamp(
      mdd,
      VALIDATION_BOUNDS.max_drawdown_pct.min,
      VALIDATION_BOUNDS.max_drawdown_pct.max
    )
  }

  // =============================================================================
  // Helper Methods
  // =============================================================================

  /**
   * 从原始数据提取数值（尝试多个字段名）
   */
  private extractNumber(
    data: Record<string, unknown>,
    ...keys: string[]
  ): number | null {
    for (const key of keys) {
      if (key in data && data[key] !== null && data[key] !== undefined) {
        const val = Number(data[key])
        if (!isNaN(val) && isFinite(val)) return val
      }
      // 尝试 camelCase 和 snake_case 变体
      const snakeKey = key.replace(/([A-Z])/g, '_$1').toLowerCase()
      if (
        snakeKey in data &&
        data[snakeKey] !== null &&
        data[snakeKey] !== undefined
      ) {
        const val = Number(data[snakeKey])
        if (!isNaN(val) && isFinite(val)) return val
      }
    }
    return null
  }

  /**
   * 从 Hyperliquid windowPerformances 提取数据
   */
  private extractFromWindowPerformances(
    data: Record<string, unknown>,
    field: 'roi' | 'pnl'
  ): number | null {
    const wp = data['windowPerformances'] as Record<string, unknown> | undefined
    if (!wp) return null

    // 优先级: week > month > allTime
    for (const window of ['week', 'month', 'allTime']) {
      const windowData = wp[window] as Record<string, unknown> | undefined
      if (windowData && field in windowData) {
        const val = Number(windowData[field])
        if (!isNaN(val) && isFinite(val)) return val
      }
    }
    return null
  }

  /**
   * 提取显示名称
   */
  private extractDisplayName(data: Record<string, unknown>): string | null {
    const keys = [
      'displayName',
      'display_name',
      'nickName',
      'nick_name',
      'name',
      'username',
      'handle',
    ]
    for (const key of keys) {
      if (key in data && typeof data[key] === 'string' && data[key]) {
        return data[key] as string
      }
    }
    return null
  }

  /**
   * 提取头像 URL
   */
  private extractAvatarUrl(data: Record<string, unknown>): string | null {
    const keys = [
      'avatarUrl',
      'avatar_url',
      'userPhotoUrl',
      'user_photo_url',
      'avatar',
      'photo',
      'profileImage',
    ]
    for (const key of keys) {
      if (key in data && typeof data[key] === 'string' && data[key]) {
        return data[key] as string
      }
    }
    return null
  }

  /**
   * 确定数据置信度
   */
  private determineConfidence(
    roi: number | null,
    pnl: number | null,
    winRate: number | null,
    maxDrawdown: number | null,
    caps: PlatformCapabilities
  ): Confidence {
    // 计算可用字段数
    const available = [roi, pnl, winRate, maxDrawdown].filter(
      (v) => v !== null
    ).length

    // 计算平台应该有的字段数
    const expected = [
      caps.fields.roi,
      caps.fields.pnl,
      caps.fields.win_rate,
      caps.fields.max_drawdown,
    ].filter(Boolean).length

    if (expected === 0) return 'minimal'

    const ratio = available / expected

    if (ratio >= 0.75) return 'full'
    if (ratio >= 0.5) return 'partial'
    return 'minimal'
  }

  /**
   * 标准化时间窗口
   */
  private normalizeWindow(window: string): TimeWindow {
    const lower = window.toLowerCase()
    if (lower === '7d' || lower === 'week' || lower === '7') return '7d'
    if (lower === '30d' || lower === 'month' || lower === '30') return '30d'
    if (lower === '90d' || lower === 'quarter' || lower === '90') return '90d'
    // 默认返回 90d
    return '90d'
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

let normalizerInstance: PipelineNormalizer | null = null

export function getNormalizer(): PipelineNormalizer {
  if (!normalizerInstance) {
    normalizerInstance = new PipelineNormalizer()
  }
  return normalizerInstance
}
