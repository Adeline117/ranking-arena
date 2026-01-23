/**
 * Data Provenance Types - 数据来源追溯系统
 *
 * 每个指标都附带来源说明，告知用户：
 * - 数据来自哪个交易所的哪个页面/接口
 * - 更新时间
 * - 窗口定义（时间范围、计算口径）
 * - 数据可用性状态
 */

import type { Exchange, DeprecatedExchange, TimeRange } from './trader'

// Re-export Exchange for convenience
export type { Exchange, TimeRange }

/**
 * All exchanges including deprecated ones.
 * Used for data provenance since historical data may come from deprecated exchanges.
 */
export type AllExchange = Exchange | DeprecatedExchange

// ============================================
// 数据来源定义
// ============================================

/** 数据来源类型 */
export type DataSourceType =
  | 'exchange_api'      // 交易所官方 API
  | 'exchange_web'      // 交易所网页抓取
  | 'arena_calculated'  // Arena 平台计算
  | 'user_connected'    // 用户绑定账号获取
  | 'third_party'       // 第三方数据源

/** 数据可用性状态 */
export type DataAvailability =
  | 'available'         // 数据可用
  | 'unavailable'       // 该交易所不提供此数据
  | 'delayed'           // 数据延迟
  | 'partial'           // 部分数据可用
  | 'stale'             // 数据过期
  | 'calculating'       // 计算中

/** 单个指标的数据来源信息 */
export interface MetricProvenance {
  /** 指标名称 */
  metricName: string
  /** 数据来源类型 */
  sourceType: DataSourceType
  /** 数据来源交易所 */
  exchange: AllExchange | 'arena'
  /** 来源页面/接口描述（用于展示给用户） */
  sourceDescription: {
    zh: string
    en: string
  }
  /** 来源 URL（如果可公开访问） */
  sourceUrl?: string
  /** 数据窗口定义 */
  windowDefinition?: {
    zh: string
    en: string
  }
  /** 计算口径说明 */
  calculationMethod?: {
    zh: string
    en: string
  }
  /** 数据可用性 */
  availability: DataAvailability
  /** 不可用原因（当 availability !== 'available' 时） */
  unavailableReason?: {
    zh: string
    en: string
  }
  /** 最后更新时间 */
  lastUpdated?: string
  /** 数据延迟说明 */
  delayInfo?: {
    zh: string
    en: string
  }
  /** 数据精度/可信度（0-100） */
  confidence?: number
}

/** 交易员完整数据的来源信息 */
export interface TraderDataProvenance {
  /** 交易员 ID */
  traderId: string
  /** 数据来源交易所 */
  exchange: AllExchange
  /** 交易所展示名称 */
  exchangeDisplayName: string
  /** 原始数据页面 URL */
  originalPageUrl?: string
  /** 数据采集时间 */
  capturedAt: string
  /** 各指标的来源信息 */
  metrics: {
    roi?: MetricProvenance
    pnl?: MetricProvenance
    win_rate?: MetricProvenance
    max_drawdown?: MetricProvenance
    trades_count?: MetricProvenance
    followers?: MetricProvenance
    arena_score?: MetricProvenance
    return_score?: MetricProvenance
    drawdown_score?: MetricProvenance
    stability_score?: MetricProvenance
    sharpe_ratio?: MetricProvenance
    sortino_ratio?: MetricProvenance
    calmar_ratio?: MetricProvenance
    equity_curve?: MetricProvenance
    position_history?: MetricProvenance
  }
  /** 数据整体新鲜度（0-100） */
  freshnessScore: number
  /** 数据整体完整度（0-100） */
  completenessScore: number
}

// ============================================
// 交易所数据能力定义
// ============================================

/** 交易所支持的数据字段 */
export interface ExchangeDataCapabilities {
  exchange: AllExchange
  displayName: string
  /** 支持的指标及其来源说明 */
  supportedMetrics: {
    roi: boolean
    pnl: boolean
    win_rate: boolean
    max_drawdown: boolean
    trades_count: boolean
    followers: boolean
    equity_curve: boolean
    position_history: boolean
    asset_breakdown: boolean
  }
  /** 数据来源说明 */
  dataSource: {
    zh: string
    en: string
  }
  /** 数据更新频率 */
  updateFrequency: {
    zh: string
    en: string
  }
  /** 数据窗口选项 */
  timeRangeOptions: TimeRange[]
  /** 备注说明 */
  notes?: {
    zh: string
    en: string
  }
}

/** 所有交易所的数据能力配置 */
export const EXCHANGE_DATA_CAPABILITIES: ExchangeDataCapabilities[] = [
  {
    exchange: 'binance',
    displayName: 'Binance',
    supportedMetrics: {
      roi: true,
      pnl: true,
      win_rate: true,
      max_drawdown: true,
      trades_count: true,
      followers: true,
      equity_curve: true,
      position_history: true,
      asset_breakdown: true,
    },
    dataSource: {
      zh: '币安合约跟单广场公开榜单',
      en: 'Binance Futures Copy Trading Leaderboard',
    },
    updateFrequency: {
      zh: '每15分钟更新',
      en: 'Updated every 15 minutes',
    },
    timeRangeOptions: ['7D', '30D', '90D', '1Y', '2Y'],
  },
  {
    exchange: 'bybit',
    displayName: 'Bybit',
    supportedMetrics: {
      roi: true,
      pnl: true,
      win_rate: true,
      max_drawdown: true,
      trades_count: true,
      followers: true,
      equity_curve: true,
      position_history: true,
      asset_breakdown: true,
    },
    dataSource: {
      zh: 'Bybit 跟单交易公开榜单',
      en: 'Bybit Copy Trading Leaderboard',
    },
    updateFrequency: {
      zh: '每15分钟更新',
      en: 'Updated every 15 minutes',
    },
    timeRangeOptions: ['7D', '30D', '90D'],
  },
  {
    exchange: 'bitget',
    displayName: 'Bitget',
    supportedMetrics: {
      roi: true,
      pnl: true,
      win_rate: true,
      max_drawdown: true,
      trades_count: true,
      followers: true,
      equity_curve: true,
      position_history: true,
      asset_breakdown: true,
    },
    dataSource: {
      zh: 'Bitget 跟单交易公开榜单',
      en: 'Bitget Copy Trading Leaderboard',
    },
    updateFrequency: {
      zh: '每小时更新',
      en: 'Updated hourly',
    },
    timeRangeOptions: ['7D', '30D', '90D'],
  },
  {
    exchange: 'okx',
    displayName: 'OKX',
    supportedMetrics: {
      roi: true,
      pnl: true,
      win_rate: true,
      max_drawdown: true,
      trades_count: true,
      followers: true,
      equity_curve: true,
      position_history: true,
      asset_breakdown: false,
    },
    dataSource: {
      zh: 'OKX 跟单交易公开榜单',
      en: 'OKX Copy Trading Leaderboard',
    },
    updateFrequency: {
      zh: '每小时更新',
      en: 'Updated hourly',
    },
    timeRangeOptions: ['7D', '30D', '90D'],
  },
  {
    exchange: 'mexc',
    displayName: 'MEXC',
    supportedMetrics: {
      roi: true,
      pnl: true,
      win_rate: true,
      max_drawdown: true,
      trades_count: false,
      followers: true,
      equity_curve: false,
      position_history: false,
      asset_breakdown: false,
    },
    dataSource: {
      zh: 'MEXC 跟单广场公开榜单',
      en: 'MEXC Copy Trading Leaderboard',
    },
    updateFrequency: {
      zh: '每4小时更新',
      en: 'Updated every 4 hours',
    },
    timeRangeOptions: ['7D', '30D', '90D'],
    notes: {
      zh: '部分详细数据需要登录查看',
      en: 'Some detailed data requires login to view',
    },
  },
  {
    exchange: 'kucoin',
    displayName: 'KuCoin',
    supportedMetrics: {
      roi: true,
      pnl: true,
      win_rate: true,
      max_drawdown: true,
      trades_count: true,
      followers: true,
      equity_curve: false,
      position_history: false,
      asset_breakdown: false,
    },
    dataSource: {
      zh: 'KuCoin 跟单交易公开榜单',
      en: 'KuCoin Copy Trading Leaderboard',
    },
    updateFrequency: {
      zh: '每4小时更新',
      en: 'Updated every 4 hours',
    },
    timeRangeOptions: ['7D', '30D', '90D'],
  },
  {
    exchange: 'coinex',
    displayName: 'CoinEx',
    supportedMetrics: {
      roi: true,
      pnl: true,
      win_rate: false,
      max_drawdown: false,
      trades_count: false,
      followers: true,
      equity_curve: false,
      position_history: false,
      asset_breakdown: false,
    },
    dataSource: {
      zh: 'CoinEx 跟单交易公开榜单',
      en: 'CoinEx Copy Trading Leaderboard',
    },
    updateFrequency: {
      zh: '每4小时更新',
      en: 'Updated every 4 hours',
    },
    timeRangeOptions: ['7D', '30D', '90D'],
    notes: {
      zh: '该交易所仅提供基础排行数据',
      en: 'This exchange only provides basic ranking data',
    },
  },
  {
    exchange: 'gate',
    displayName: 'Gate.io',
    supportedMetrics: {
      roi: true,
      pnl: true,
      win_rate: true,
      max_drawdown: true,
      trades_count: true,
      followers: true,
      equity_curve: true,
      position_history: false,
      asset_breakdown: false,
    },
    dataSource: {
      zh: 'Gate.io 跟单交易公开榜单',
      en: 'Gate.io Copy Trading Leaderboard',
    },
    updateFrequency: {
      zh: '每小时更新',
      en: 'Updated hourly',
    },
    timeRangeOptions: ['7D', '30D', '90D'],
  },
]

// ============================================
// 辅助函数
// ============================================

/**
 * 获取交易所的数据能力配置
 */
export function getExchangeCapabilities(exchange: AllExchange): ExchangeDataCapabilities | undefined {
  return EXCHANGE_DATA_CAPABILITIES.find(e => e.exchange === exchange)
}

/**
 * 检查交易所是否支持某个指标
 */
export function isMetricSupported(exchange: AllExchange, metric: keyof ExchangeDataCapabilities['supportedMetrics']): boolean {
  const capabilities = getExchangeCapabilities(exchange)
  return capabilities?.supportedMetrics[metric] ?? false
}

/**
 * 生成默认的指标来源信息
 */
export function createDefaultMetricProvenance(
  metricName: string,
  exchange: AllExchange,
  availability: DataAvailability = 'available',
  lastUpdated?: string
): MetricProvenance {
  const capabilities = getExchangeCapabilities(exchange)

  return {
    metricName,
    sourceType: 'exchange_web',
    exchange,
    sourceDescription: capabilities?.dataSource ?? {
      zh: `${exchange} 公开榜单`,
      en: `${exchange} Public Leaderboard`,
    },
    availability,
    lastUpdated,
    confidence: availability === 'available' ? 95 : 0,
  }
}

/**
 * 计算数据新鲜度分数
 * @param lastUpdated 最后更新时间（ISO 字符串）
 * @returns 0-100 的新鲜度分数
 */
export function calculateFreshnessScore(lastUpdated?: string): number {
  if (!lastUpdated) return 0

  const now = Date.now()
  const updated = new Date(lastUpdated).getTime()
  const ageMinutes = (now - updated) / (1000 * 60)

  // 15分钟内: 100分
  // 1小时内: 80分
  // 4小时内: 60分
  // 24小时内: 40分
  // 超过24小时: 20分
  if (ageMinutes <= 15) return 100
  if (ageMinutes <= 60) return 80
  if (ageMinutes <= 240) return 60
  if (ageMinutes <= 1440) return 40
  return 20
}

/**
 * 计算数据完整度分数
 * @param provenance 交易员数据来源信息
 * @returns 0-100 的完整度分数
 */
export function calculateCompletenessScore(metrics: TraderDataProvenance['metrics']): number {
  const allMetrics = Object.values(metrics).filter(Boolean)
  if (allMetrics.length === 0) return 0

  const availableCount = allMetrics.filter(m => m?.availability === 'available').length
  return Math.round((availableCount / allMetrics.length) * 100)
}

/**
 * 格式化数据更新时间为可读文本
 */
export function formatLastUpdated(lastUpdated?: string, language: 'zh' | 'en' = 'zh'): string {
  if (!lastUpdated) {
    return language === 'zh' ? '未知' : 'Unknown'
  }

  const now = Date.now()
  const updated = new Date(lastUpdated).getTime()
  const diffMs = now - updated
  const diffMinutes = Math.floor(diffMs / (1000 * 60))
  const diffHours = Math.floor(diffMinutes / 60)
  const diffDays = Math.floor(diffHours / 24)

  if (diffMinutes < 1) {
    return language === 'zh' ? '刚刚更新' : 'Just now'
  }
  if (diffMinutes < 60) {
    return language === 'zh' ? `${diffMinutes}分钟前` : `${diffMinutes}m ago`
  }
  if (diffHours < 24) {
    return language === 'zh' ? `${diffHours}小时前` : `${diffHours}h ago`
  }
  if (diffDays < 7) {
    return language === 'zh' ? `${diffDays}天前` : `${diffDays}d ago`
  }

  // 超过7天显示具体日期
  const date = new Date(lastUpdated)
  return date.toLocaleDateString(language === 'zh' ? 'zh-CN' : 'en-US', {
    month: 'short',
    day: 'numeric',
  })
}
