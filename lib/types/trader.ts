/**
 * 交易员相关类型定义
 * 所有交易员相关的类型集中在这里，消除 any 类型
 */

// ============================================
// 交易所和数据源
// ============================================

/** 支持的交易所 */
export const EXCHANGES = ['binance', 'bybit', 'bitget', 'okx', 'kucoin', 'gate', 'mexc', 'coinex'] as const
export const EXCHANGES_WITH_WEB3 = ['binance_web3', ...EXCHANGES] as const

export type Exchange = typeof EXCHANGES[number]
export type ExchangeWithWeb3 = typeof EXCHANGES_WITH_WEB3[number]

/** 时间范围 */
export type TimeRange = '7D' | '30D' | '90D' | '1Y' | '2Y' | 'All'

/** 交易风格标签 */
export type TradingStyle = 'high_frequency' | 'swing' | 'trend' | 'scalping' | 'position'

/** 风险等级 */
export type RiskLevel = 1 | 2 | 3 | 4 | 5

// ============================================
// 交易员数据源记录
// ============================================

/** 交易员数据源记录 */
export interface TraderSourceRecord {
  source_trader_id: string
  handle: string | null
  profile_url: string | null
  source: string
}

// ============================================
// 交易员基本信息
// ============================================

/** 交易员基本资料 */
export interface TraderProfile {
  handle: string
  id: string
  bio?: string
  followers?: number
  following?: number
  copiers?: number
  avatar_url?: string
  isRegistered?: boolean
  source?: string
  /** 交易风格标签 */
  tradingStyle?: TradingStyle
  /** 验证状态 */
  isVerified?: boolean
}

// ============================================
// 交易员绩效数据
// ============================================

/** 交易员绩效数据 */
export interface TraderPerformance {
  roi_7d?: number
  roi_30d?: number
  roi_90d?: number
  roi_1y?: number
  roi_2y?: number
  return_ytd?: number
  return_2y?: number
  pnl?: number
  win_rate?: number
  max_drawdown?: number
  pnl_7d?: number
  pnl_30d?: number
  win_rate_7d?: number
  win_rate_30d?: number
  max_drawdown_7d?: number
  max_drawdown_30d?: number
  risk_score_last_7d?: number
  profitable_weeks?: number
  monthlyPerformance?: MonthlyPerformance[]
  yearlyPerformance?: YearlyPerformance[]
}

/** 月度绩效 */
export interface MonthlyPerformance {
  month: string  // YYYY-MM 格式
  value: number  // ROI 百分比
}

/** 年度绩效 */
export interface YearlyPerformance {
  year: number
  value: number  // ROI 百分比
}

// ============================================
// 交易员统计数据
// ============================================

/** 交易统计 */
export interface TradingStats {
  totalTrades12M: number
  avgProfit: number
  avgLoss: number
  profitableTradesPct: number
}

/** 频繁交易资产 */
export interface FrequentlyTradedAsset {
  symbol: string
  weightPct: number
  count: number
  avgProfit: number
  avgLoss: number
  profitablePct: number
}

/** 附加统计 */
export interface AdditionalStats {
  tradesPerWeek?: number
  avgHoldingTime?: string
  activeSince?: string
  profitableWeeksPct?: number
  riskScore?: number
  volume90d?: number
  maxDrawdown?: number
  sharpeRatio?: number
  sortinoRatio?: number
  calmarRatio?: number
}

/** 交易员完整统计 */
export interface TraderStats {
  expectedDividends?: {
    dividendYield: number
    assets: number
    trendingStocks: Array<{ symbol: string; yield: number; icon?: string }>
  }
  trading?: TradingStats
  frequentlyTraded?: FrequentlyTradedAsset[]
  additionalStats?: AdditionalStats
  monthlyPerformance?: MonthlyPerformance[]
  yearlyPerformance?: YearlyPerformance[]
}

// ============================================
// 投资组合和持仓
// ============================================

/** 投资组合项 */
export interface PortfolioItem {
  market: string
  direction: 'long' | 'short'
  invested: number
  pnl: number
  value: number
  price: number
  priceChange?: number
  priceChangePct?: number
}

/** 历史持仓 */
export interface PositionHistoryItem {
  symbol: string
  direction: 'long' | 'short'
  entryPrice: number
  exitPrice: number
  pnlPct: number
  openTime: string
  closeTime: string
  /** 持仓时长（小时） */
  holdingHours?: number
  /** 杠杆倍数 */
  leverage?: number
}

// ============================================
// 交易员动态
// ============================================

/** 动态类型 */
export type FeedItemType = 'post' | 'group_post' | 'repost'

/** 交易员动态 */
export interface TraderFeedItem {
  id: string
  type: FeedItemType
  title: string
  content?: string
  time: string
  groupId?: string
  groupName?: string
  like_count?: number
  is_pinned?: boolean
  repost_comment?: string
  original_author_handle?: string
  original_post_id?: string
}

// ============================================
// 排行榜数据
// ============================================

/** 排行榜交易员数据 */
export interface RankedTrader {
  id: string
  handle: string
  roi: number
  pnl: number
  win_rate: number
  max_drawdown: number | null
  trades_count: number | null
  followers: number
  source: string
  avatar_url: string | null
  /** 风险调整得分 */
  risk_adjusted_score?: number
  /** 稳定性得分 */
  stability_score?: number
  /** 是否可疑 */
  is_suspicious?: boolean
  /** 可疑原因 */
  suspicion_reasons?: string[]
}

/** 排行榜查询参数 */
export interface RankingQueryParams {
  timeRange: TimeRange
  exchange?: Exchange
  minPnl?: number
  minTrades?: number
  sortBy?: 'roi' | 'pnl' | 'win_rate' | 'risk_adjusted'
  limit?: number
  offset?: number
}

// ============================================
// 相似交易员
// ============================================

/** 交易员向量（用于相似度计算） */
export interface TraderVector {
  roi: number
  winRate: number
  maxDrawdown: number
  tradesCount: number
  avgHoldingTime: number
  volatility: number
}

/** 相似交易员结果 */
export interface SimilarTrader extends TraderProfile {
  /** 相似度得分 (0-1) */
  similarityScore: number
  /** 相似维度 */
  similarDimensions: string[]
}

// ============================================
// 风险指标
// ============================================

/** 风险指标 */
export interface RiskMetrics {
  sharpeRatio: number | null
  sortinoRatio: number | null
  calmarRatio: number | null
  volatility: number | null
  downwardVolatility: number | null
  maxDrawdown: number | null
  maxDrawdownDuration: number | null
  maxConsecutiveLosses: number | null
  maxConsecutiveWins: number | null
  profitLossRatio: number | null
  rewardRiskRatio: number | null
  riskLevel: RiskLevel
  riskLevelDescription: string
}

// ============================================
// API 响应类型
// ============================================

/** 交易员列表响应 */
export interface TradersListResponse {
  traders: RankedTrader[]
  timeRange: TimeRange
  totalCount: number
  rankingMode?: 'simple' | 'risk_adjusted'
}

/** 交易员详情响应 */
export interface TraderDetailResponse {
  profile: TraderProfile
  performance: TraderPerformance
  stats: TraderStats
  riskMetrics?: RiskMetrics
}

// ============================================
// 工具类型
// ============================================

/** 分页参数 */
export interface PaginationParams {
  limit: number
  offset: number
}

/** 分页响应 */
export interface PaginatedResponse<T> {
  data: T[]
  pagination: {
    limit: number
    offset: number
    total: number
    hasMore: boolean
  }
}
