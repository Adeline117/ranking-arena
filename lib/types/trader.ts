/**
 * 交易员相关类型定义
 * 所有交易员相关的类型集中在这里，消除 any 类型
 */

// ============================================
// 交易所和数据源
// ============================================

/**
 * 支持的交易所
 * v2.0: 精简为 4 个核心交易所，移除低使用率交易所 (kucoin, gate, mexc, coinex)
 * 理由：维护成本高、数据质量参差不齐、用户需求集中在头部交易所
 */
export const EXCHANGES = ['binance', 'bybit', 'bitget', 'okx'] as const
export const EXCHANGES_WITH_WEB3 = ['binance_web3', ...EXCHANGES] as const

/** 已下线的交易所（保留类型定义用于数据迁移） */
export const DEPRECATED_EXCHANGES = ['kucoin', 'gate', 'mexc', 'coinex'] as const
export type DeprecatedExchange = typeof DEPRECATED_EXCHANGES[number]

export type Exchange = typeof EXCHANGES[number]
export type ExchangeWithWeb3 = typeof EXCHANGES_WITH_WEB3[number]

/** 时间范围 */
export type TimeRange = '7D' | '30D' | '90D' | '1Y' | '2Y' | 'All'

/**
 * Trading style classification
 * This is the canonical definition - all other files should import from here
 *
 * Values:
 * - scalper: High-frequency, short holding periods (<4h), many trades
 * - swing: Medium-term trades, holding 4-48 hours
 * - trend: Longer-term trend following, holding 48h-2 weeks
 * - position: Long-term holding, >2 weeks
 * - unknown: Unable to classify (insufficient data)
 */
export type TradingStyle = 'scalper' | 'swing' | 'trend' | 'position' | 'unknown'

/**
 * Valid trading styles for API filtering (excludes 'unknown')
 */
export const VALID_TRADING_STYLES = ['scalper', 'swing', 'trend', 'position'] as const
export type FilterableTradingStyle = (typeof VALID_TRADING_STYLES)[number]

/**
 * Legacy mapping for backwards compatibility with APIs
 * @deprecated Use TradingStyle instead
 */
export type TradingStyleLegacy = 'high_frequency' | 'swing' | 'trend' | 'scalping' | 'position'

/**
 * Maps legacy style names to current style names
 */
export const TRADING_STYLE_LEGACY_MAP: Record<TradingStyleLegacy | 'hft' | 'day_trader', TradingStyle> = {
  high_frequency: 'scalper',
  hft: 'scalper',
  scalping: 'scalper',
  day_trader: 'swing',
  swing: 'swing',
  trend: 'trend',
  position: 'position',
}

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
  display_name?: string | null
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
  /** Arena Score - 7天 (0-100) */
  arena_score_7d?: number
  /** Arena Score - 30天 (0-100) */
  arena_score_30d?: number
  /** Arena Score - 90天 (0-100) */
  arena_score_90d?: number
  /** 总体评分 (0-100) - 加权计算：70% 90D + 25% 30D + 5% 7D */
  overall_score?: number
  /** Arena Score 综合评分 */
  arena_score?: number | null
  /** 收益评分 (0-100) */
  return_score?: number | null
  /** 回撤评分 (0-100) */
  drawdown_score?: number | null
  /** 稳定性评分 (0-100) */
  stability_score?: number | null
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

/**
 * 排行榜表格中的交易员数据
 * 用于 RankingTable 组件和 useTraderData hook
 */
export interface Trader {
  id: string
  handle: string | null
  display_name?: string | null
  roi: number
  pnl?: number | null
  win_rate?: number | null
  max_drawdown?: number | null
  trades_count?: number | null
  followers: number
  source?: string
  avatar_url?: string | null
  arena_score?: number
  return_score?: number
  drawdown_score?: number
  stability_score?: number
}

/** 排行榜交易员数据（严格版本，所有字段必需） */
export interface RankedTrader {
  id: string
  handle: string
  roi: number
  pnl: number
  /** 胜率 (0-100)，GMX 等交易所无此字段 */
  win_rate: number | null
  /** 最大回撤 (%)，GMX 等交易所无此字段 */
  max_drawdown: number | null
  trades_count: number | null
  /** 跟单人数，GMX 无跟单功能 */
  followers: number | null
  source: string
  avatar_url: string | null
  /** Arena Score V2 (0-100) - 核心排名指标 */
  arena_score?: number
  /** Arena Score V3 (0-100) - 新版排名指标 */
  arena_score_v3?: number
  /** 收益分 (V2: 0-70, V3: 0-55) */
  return_score?: number
  /** PnL 分 (V2: 0-15, V3: 0-12) */
  pnl_score?: number
  /** 回撤分 (0-8) */
  drawdown_score?: number
  /** 稳定分 (V2: 0-7, V3: 0-5) */
  stability_score?: number
  /** Alpha 分 (V3 only: 0-5) */
  alpha_score?: number
  /** 风险调整分 (V3 only: 0-10) */
  risk_adjusted_score_v3?: number
  /** 一致性分 (V3 only: 0-5) */
  consistency_score?: number
  /** 风险调整得分（V1旧版兼容） */
  risk_adjusted_score?: number
  /** Sortino Ratio */
  sortino_ratio?: number | null
  /** Calmar Ratio */
  calmar_ratio?: number | null
  /** Alpha (超额收益) */
  alpha?: number | null
  /** 交易风格 */
  trading_style?: TradingStyle | null
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
  /** 排序字段 */
  sortBy?: 'roi' | 'pnl' | 'win_rate' | 'risk_adjusted' | 'arena_score' | 'arena_score_v3' | 'sortino' | 'calmar' | 'alpha'
  /** 交易风格过滤 */
  tradingStyle?: TradingStyle
  /** 最小 Alpha 阈值 */
  minAlpha?: number
  /** 最小 Sharpe Ratio 阈值 */
  minSharpe?: number
  /** 最小 Sortino Ratio 阈值 */
  minSortino?: number
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
// Advanced Metrics (V3)
// ============================================

/** 高级交易指标 */
export interface TraderAdvancedMetrics {
  /** Sortino Ratio - 下行风险调整收益 */
  sortino_ratio: number | null
  /** Calmar Ratio - 年化收益/最大回撤 */
  calmar_ratio: number | null
  /** Profit Factor - 总盈利/总亏损 */
  profit_factor: number | null
  /** Recovery Factor - 净利润/最大回撤 */
  recovery_factor: number | null
  /** 最大连续盈利次数 */
  max_consecutive_wins: number | null
  /** 最大连续亏损次数 */
  max_consecutive_losses: number | null
  /** 平均持仓时间（小时） */
  avg_holding_hours: number | null
  /** 收益波动率 (%) */
  volatility_pct: number | null
  /** 下行波动率 (%) */
  downside_volatility_pct: number | null
}

/** 市场条件类型 */
export type MarketCondition = 'bull' | 'bear' | 'sideways'

/** 市场相关性指标 */
export interface TraderMarketCorrelation {
  /** BTC Beta - 与BTC的相关系数 */
  beta_btc: number | null
  /** ETH Beta - 与ETH的相关系数 */
  beta_eth: number | null
  /** Alpha - 超额收益（Jensen's Alpha） */
  alpha: number | null
  /** 不同市场条件下的表现 */
  market_condition_performance: Record<MarketCondition, number | null>
}

/** 交易员分类信息 */
export interface TraderClassification {
  /** 交易风格 */
  trading_style: TradingStyle | null
  /** 偏好资产列表 */
  asset_preference: string[]
  /** 风格分类置信度 (0-100) */
  style_confidence: number | null
}

/** 实时持仓数据 */
export interface TraderPositionLive {
  id: string
  platform: string
  market_type: string
  trader_key: string
  symbol: string
  side: 'long' | 'short'
  entry_price: number
  current_price: number | null
  mark_price: number | null
  quantity: number
  leverage: number
  margin: number | null
  unrealized_pnl: number | null
  unrealized_pnl_pct: number | null
  liquidation_price: number | null
  opened_at: string | null
  updated_at: string
}

/** 跟单情报信息 */
export interface CopyTradingIntel {
  /** 预估滑点 (%) */
  slippage_estimate_pct: number | null
  /** 流动性评分 (0-100) */
  liquidity_score: number | null
  /** 建议仓位大小 (USD) */
  recommended_position_size: number | null
  /** 最大建议资金 (USD) */
  max_recommended_capital: number | null
  /** 警告信息 */
  warnings: string[]
}

/** Arena Score V3 组件 */
export interface ArenaScoreV3Components {
  /** 收益分 (0-55) */
  return_score: number
  /** PnL 分 (0-12) */
  pnl_score: number
  /** 回撤分 (0-8) */
  drawdown_score: number
  /** 稳定分 (0-5) */
  stability_score: number
  /** Alpha 分 (0-5) */
  alpha_score: number
  /** 风险调整分 (0-10) */
  risk_adjusted_score: number
  /** 一致性分 (0-5) */
  consistency_score: number
  /** 总分 (0-100) */
  total_score: number
}

/** 扩展的交易员详情响应 */
export interface TraderDetailResponseV2 {
  profile: TraderProfile
  performance: TraderPerformance
  stats: TraderStats
  riskMetrics?: RiskMetrics
  /** V3 高级指标 */
  advanced_metrics?: TraderAdvancedMetrics
  /** 市场相关性 */
  market_correlation?: TraderMarketCorrelation
  /** 交易员分类 */
  classification?: TraderClassification
  /** 跟单情报 */
  copy_trading_intel?: CopyTradingIntel
  /** 实时持仓（仅Pro用户） */
  live_positions?: TraderPositionLive[]
  /** Arena Score V3 详情 */
  arena_score_v3?: ArenaScoreV3Components
}

// ============================================
// API 响应类型
// ============================================

/** 交易员列表响应 */
export interface TradersListResponse {
  traders: RankedTrader[]
  timeRange: TimeRange
  totalCount: number
  rankingMode?: 'simple' | 'risk_adjusted' | 'arena_score'
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

/**
 * 交易员列表分页参数（必填字段版本）
 * 用于 trader API 调用时需要明确分页的场景
 *
 * 注：通用分页参数请使用 lib/types/index.ts 中的 PaginationParams
 */
export interface TraderPaginationParams {
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
