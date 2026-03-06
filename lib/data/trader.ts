/**
 * Trader Data Adapter
 * 数据适配层 - 从 Supabase 获取交易员数据
 * 
 * 优化版本：
 * - 消除 N+1 查询问题，使用批量查询
 * - 统一数据源查找逻辑，减少代码重复
 * - 使用 OR 条件替代循环查询
 */

import { supabase } from '@/lib/supabase/client'
import type { SupabaseClient } from '@supabase/supabase-js'
import * as cache from '@/lib/cache'
import { CacheKey, CACHE_TTL } from '@/lib/cache'
import { createLogger } from '@/lib/utils/logger'

const logger = createLogger('trader-data')

// 支持的交易所数据源
export const TRADER_SOURCES = ['binance', 'bybit', 'bitget', 'okx', 'kucoin', 'gate', 'mexc', 'coinex'] as const
export const TRADER_SOURCES_WITH_WEB3 = ['binance_web3', ...TRADER_SOURCES] as const

export type TraderSource = typeof TRADER_SOURCES[number]
export type TraderSourceWithWeb3 = typeof TRADER_SOURCES_WITH_WEB3[number]

// ============================================
// 类型定义
// ============================================

export interface TraderSourceRecord {
  source_trader_id: string
  handle: string | null
  profile_url: string | null
  source: string
}

export interface TraderProfile {
  handle: string
  display_name?: string | null
  trader_key?: string
  id: string
  uid?: number // 数字用户编号，用于展示和搜索
  bio?: string
  followers?: number
  following?: number // 关注的用户数量 (user_follows)
  followingTraders?: number // 关注的交易员数量 (trader_follows)
  copiers?: number
  avatar_url?: string
  cover_url?: string // 用户主页背景图片
  isRegistered?: boolean
  source?: string
  // 隐私设置
  showFollowers?: boolean
  showFollowing?: boolean
}

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
  monthlyPerformance?: Array<{ month: string; value: number }>
  yearlyPerformance?: Array<{ year: number; value: number }>
  // Arena Score 评分系统
  arena_score?: number | null
  return_score?: number | null
  drawdown_score?: number | null
  stability_score?: number | null
  // V3 三维度评分
  profitability_score?: number | null
  risk_control_score?: number | null
  execution_score?: number | null
  arena_score_v3?: number | null
  score_completeness?: string | null
  score_penalty?: number | null
}

export interface TraderStats {
  expectedDividends?: {
    dividendYield: number
    assets: number
    trendingStocks: Array<{ symbol: string; yield: number; icon?: string }>
  }
  trading?: {
    totalTrades12M: number
    avgProfit: number
    avgLoss: number
    profitableTradesPct: number
  }
  frequentlyTraded?: Array<{
    symbol: string
    weightPct: number
    count: number
    avgProfit: number
    avgLoss: number
    profitablePct: number
  }>
  additionalStats?: {
    tradesPerWeek?: number
    avgHoldingTime?: string
    activeSince?: string
    profitableWeeksPct?: number
    riskScore?: number
    volume90d?: number
    maxDrawdown?: number
    sharpeRatio?: number
  }
  monthlyPerformance?: Array<{ month: string; value: number }>
  yearlyPerformance?: Array<{ year: number; value: number }>
}

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

export interface PositionHistoryItem {
  symbol: string
  direction: 'long' | 'short'
  entryPrice: number
  exitPrice: number
  pnlPct: number
  openTime: string
  closeTime: string
}

export interface TraderFeedItem {
  id: string
  type: 'post' | 'group_post' | 'repost'
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
// 核心工具函数 - 消除重复代码
// ============================================

/**
 * 统一的交易员数据源查找函数
 * 使用单次查询替代循环遍历所有数据源
 * 优化：使用 OR 条件和 IN 查询减少数据库请求次数
 * @alias findTraderAcrossSources
 */
export async function findTraderAcrossSources(
  handle: string,
  options: {
    includeWeb3?: boolean
    client?: SupabaseClient
  } = {}
): Promise<TraderSourceRecord | null> {
  const { includeWeb3 = true, client = supabase } = options
  const decodedHandle = decodeURIComponent(handle)
  const sources = includeWeb3 ? TRADER_SOURCES_WITH_WEB3 : TRADER_SOURCES

  try {
    // 单次查询：同时按 handle 和 source_trader_id 查找
    // 使用 or() 条件合并多个查询条件
    const handleConditions = [
      `handle.eq.${handle}`,
      `source_trader_id.eq.${handle}`,
    ]
    
    if (decodedHandle !== handle) {
      handleConditions.push(`handle.eq.${decodedHandle}`)
      handleConditions.push(`source_trader_id.eq.${decodedHandle}`)
    }

    const { data, error } = await client
      .from('trader_sources')
      .select('source_trader_id, handle, profile_url, source')
      .in('source', sources as unknown as string[])
      .or(handleConditions.join(','))
      .limit(10)

    if (error) {
      return null
    }

    if (!data || data.length === 0) {
      return null
    }

    // 如果有多个结果，优先返回有快照数据的
    if (data.length > 1) {
      const traderIds = data.map(d => d.source_trader_id)
      
      // 批量查询哪些有快照数据
      const { data: snapshots } = await client
        .from('trader_snapshots')
        .select('source_trader_id')
        .in('source_trader_id', traderIds)
        .limit(traderIds.length)

      if (snapshots && snapshots.length > 0) {
        const snapshotIds = new Set(snapshots.map(s => s.source_trader_id))
        const withSnapshot = data.find(d => snapshotIds.has(d.source_trader_id))
        if (withSnapshot) {
          return withSnapshot as TraderSourceRecord
        }
      }
    }

    return data[0] as TraderSourceRecord
  } catch (error) {
    logger.warn('findTraderAcrossSources failed', { error: error instanceof Error ? error.message : String(error) })
    return null
  }
}

/**
 * 批量获取多个交易员的数据源信息
 */
export async function findTradersAcrossSources(
  handles: string[],
  options: {
    includeWeb3?: boolean
    client?: SupabaseClient
  } = {}
): Promise<Map<string, TraderSourceRecord>> {
  const { includeWeb3 = true, client = supabase } = options
  const sources = includeWeb3 ? TRADER_SOURCES_WITH_WEB3 : TRADER_SOURCES
  const result = new Map<string, TraderSourceRecord>()

  if (handles.length === 0) return result

  try {
    // 构建所有可能的查询条件
    const allHandles = new Set<string>()
    handles.forEach(h => {
      allHandles.add(h)
      const decoded = decodeURIComponent(h)
      if (decoded !== h) allHandles.add(decoded)
    })
    const handleList = Array.from(allHandles)

    // 批量查询
    const { data, error } = await client
      .from('trader_sources')
      .select('source_trader_id, handle, profile_url, source')
      .in('source', sources as unknown as string[])
      .or(`handle.in.(${handleList.join(',')}),source_trader_id.in.(${handleList.join(',')})`)

    if (error || !data) {
      return result
    }

    // 按 handle 和 source_trader_id 建立映射
    data.forEach(record => {
      const rec = record as TraderSourceRecord
      if (rec.handle) result.set(rec.handle, rec)
      result.set(rec.source_trader_id, rec)
    })

    return result
  } catch (error) {
    logger.warn('findTradersAcrossSources failed', { error: error instanceof Error ? error.message : String(error) })
    return result
  }
}

/**
 * 获取交易员的 Arena 粉丝数（批量版本）
 */
async function getTraderArenaFollowersCountBatch(
  client: SupabaseClient,
  traderIds: string[]
): Promise<Map<string, number>> {
  const result = new Map<string, number>()
  if (traderIds.length === 0) return result

  try {
    const { data, error } = await client
      .from('trader_follows')
      .select('trader_id')
      .in('trader_id', traderIds)
      .limit(10000)

    if (error || !data) return result

    // 统计每个 trader 的粉丝数
    const counts = new Map<string, number>()
    data.forEach((row: { trader_id: string }) => {
      counts.set(row.trader_id, (counts.get(row.trader_id) || 0) + 1)
    })

    return counts
  } catch (error) {
    logger.warn('getTraderArenaFollowersCountBatch failed', { error: error instanceof Error ? error.message : String(error) })
    return result
  }
}

// ============================================
// 公开 API 函数
// ============================================

/**
 * 根据 handle 获取交易员基本信息
 * 优化版本：减少数据库查询次数
 */
export async function getTraderByHandle(handle: string): Promise<TraderProfile | null> {
  if (!handle) return null

  const cacheKey = CacheKey.traders.detail(handle)

  // 使用缓存包装查询
  return cache.getOrSet(
    cacheKey,
    async () => {
      try {
        // 单次查询找到交易员
        const source = await findTraderAcrossSources(handle)
        
        if (!source) {
          return null
        }

        // 并行获取粉丝数和用户资料
        const [followersCount, profileData] = await Promise.all([
          // 获取 Arena 粉丝数
          (async () => {
            const { getTraderArenaFollowersCount } = await import('./trader-followers')
            return getTraderArenaFollowersCount(supabase, source.source_trader_id)
          })(),
          // 检查是否在平台注册
          (async () => {
            const profileHandle = source.handle || source.source_trader_id
            const decodedHandle = decodeURIComponent(handle)
            
            const { data } = await supabase
              .from('user_profiles')
              .select('id, bio, avatar_url, cover_url')
              .or(`handle.eq.${profileHandle},handle.eq.${decodedHandle},handle.eq.${handle}`)
              .limit(1)
              .maybeSingle()

            return data
          })()
        ])

        return {
          handle: source.handle || source.source_trader_id,
          id: source.source_trader_id,
          bio: profileData?.bio || undefined,
          followers: followersCount,
          copiers: 0,
          // 优先使用用户在平台设置的头像，否则使用交易所头像
          avatar_url: profileData?.avatar_url || source.profile_url || undefined,
          // 用户设置的背景图
          cover_url: profileData?.cover_url || undefined,
          isRegistered: !!profileData,
          source: source.source,
        }
      } catch (error) {
        const logger = createLogger('trader-data')
        logger.error('Error in getTraderByHandle', { error, handle })
        return null
      }
    },
    { ttl: CACHE_TTL.TRADER_DETAIL }
  )
}

/**
 * 获取交易员绩效数据
 * 优化版本：使用单次查询 + 并行查询 + Redis 缓存
 */
export async function getTraderPerformance(
  handle: string,
  period: '7D' | '30D' | '90D' | '1Y' | '2Y' | 'All' = '90D'
): Promise<TraderPerformance> {
  const cacheKey = CacheKey.traders.performance(handle, period)

  return cache.getOrSet(
    cacheKey,
    async () => {
      try {
        // 先找到交易员
        const source = await findTraderAcrossSources(handle)
        
        if (!source) {
          return { roi_90d: 0 }
        }

        // 并行查询所有时间段的数据
        const [snapshot90d, snapshot7d, snapshot30d] = await Promise.all([
          // 90D 数据（默认）
          supabase
            .from('trader_snapshots')
            .select('roi, pnl, win_rate, max_drawdown')
            .eq('source', source.source)
            .eq('source_trader_id', source.source_trader_id)
            .eq('season_id', '90D')
            .order('captured_at', { ascending: false })
            .limit(1)
            .maybeSingle(),
          // 7D 数据
          supabase
            .from('trader_snapshots')
            .select('roi, pnl, win_rate, max_drawdown')
            .eq('source', source.source)
            .eq('source_trader_id', source.source_trader_id)
            .eq('season_id', '7D')
            .order('captured_at', { ascending: false })
            .limit(1)
            .maybeSingle(),
          // 30D 数据
          supabase
            .from('trader_snapshots')
            .select('roi, pnl, win_rate, max_drawdown')
            .eq('source', source.source)
            .eq('source_trader_id', source.source_trader_id)
            .eq('season_id', '30D')
            .order('captured_at', { ascending: false })
            .limit(1)
            .maybeSingle(),
        ])

        const data90d = snapshot90d.data
        const data7d = snapshot7d.data
        const data30d = snapshot30d.data

        return {
          roi_90d: data90d?.roi ?? 0,
          roi_7d: data7d?.roi ?? undefined,
          roi_30d: data30d?.roi ?? undefined,
          pnl: data90d?.pnl ?? undefined,
          win_rate: data90d?.win_rate ?? undefined,
          max_drawdown: data90d?.max_drawdown ?? undefined,
          pnl_7d: data7d?.pnl ?? undefined,
          pnl_30d: data30d?.pnl ?? undefined,
          win_rate_7d: data7d?.win_rate ?? undefined,
          win_rate_30d: data30d?.win_rate ?? undefined,
          max_drawdown_7d: data7d?.max_drawdown ?? undefined,
          max_drawdown_30d: data30d?.max_drawdown ?? undefined,
          roi_1y: undefined,
          roi_2y: undefined,
        }
      } catch (error) {
        const logger = createLogger('trader-data')
        logger.error('Error in getTraderPerformance', { error, handle })
        return { roi_90d: 0 }
      }
    },
    { ttl: CACHE_TTL.TRADER_PERFORMANCE }
  )
}

/**
 * 获取交易员统计数据
 * 优化版本：并行查询所有相关数据
 */
export async function getTraderStats(handle: string): Promise<TraderStats> {
  try {
    const source = await findTraderAcrossSources(handle)
    
    if (!source) {
      return { additionalStats: {} }
    }

    // 并行查询所有需要的数据
    const [latestSnapshotResult, historySnapshotsResult, frequentlyTradedResult, monthlyResult, yearlyResult] = await Promise.all([
      // 最新快照
      supabase
        .from('trader_snapshots')
        .select('roi, captured_at, pnl, win_rate, max_drawdown, trades_count, holding_days')
        .eq('source', source.source)
        .eq('source_trader_id', source.source_trader_id)
        .order('captured_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      // 历史快照（用于计算 profitableWeeksPct，限制最近 200 条）
      supabase
        .from('trader_snapshots')
        .select('roi, captured_at')
        .eq('source', source.source)
        .eq('source_trader_id', source.source_trader_id)
        .order('captured_at', { ascending: false })
        .limit(200),
      // 频繁交易资产
      (async () => {
        const { data: latestCapturedAt } = await supabase
          .from('trader_snapshots')
          .select('captured_at')
          .eq('source', source.source)
          .eq('source_trader_id', source.source_trader_id)
          .order('captured_at', { ascending: false })
          .limit(1)
          .maybeSingle()
        
        if (!latestCapturedAt) return { data: null }
        
        return supabase
          .from('trader_frequently_traded')
          .select('symbol, weight_pct, trade_count, avg_profit, avg_loss, profitable_pct')
          .eq('source', source.source)
          .eq('source_trader_id', source.source_trader_id)
          .eq('captured_at', latestCapturedAt.captured_at)
          .order('weight_pct', { ascending: false })
          .limit(10)
      })(),
      // 月度表现
      supabase
        .from('trader_monthly_performance')
        .select('year, month, roi')
        .eq('source', source.source)
        .eq('source_trader_id', source.source_trader_id)
        .order('year', { ascending: false })
        .order('month', { ascending: false })
        .limit(12),
      // 年度表现
      supabase
        .from('trader_yearly_performance')
        .select('year, roi')
        .eq('source', source.source)
        .eq('source_trader_id', source.source_trader_id)
        .order('year', { ascending: false })
        .limit(5),
    ])

    const latestSnapshot = latestSnapshotResult.data
    const snapshots = historySnapshotsResult.data || []
    const frequentlyTradedData = frequentlyTradedResult.data || []
    const monthlyData = monthlyResult.data || []
    const yearlyData = yearlyResult.data || []

    if (snapshots.length === 0) {
      return { additionalStats: {} }
    }

    // 计算 activeSince（snapshots 按 captured_at DESC 排序，最早的在末尾）
    const earliestSnapshot = snapshots[snapshots.length - 1]
    const activeSinceDate = new Date(earliestSnapshot.captured_at)
    const activeSince = `${activeSinceDate.getMonth() + 1}/${activeSinceDate.getDate()}/${activeSinceDate.getFullYear().toString().slice(-2)}`

    // 计算 profitableWeeksPct
    let profitableWeeksPct: number | undefined = undefined
    if (snapshots.length > 1) {
      const profitableWeeks = snapshots.filter(s => (s.roi || 0) > 0).length
      profitableWeeksPct = (profitableWeeks / snapshots.length) * 100
    }

    // 格式化频繁交易资产
    const frequentlyTraded = frequentlyTradedData.map((item: {
      symbol: string
      weight_pct: number | null
      trade_count: number | null
      avg_profit: number | null
      avg_loss: number | null
      profitable_pct: number | null
    }) => ({
      symbol: item.symbol,
      weightPct: item.weight_pct ?? 0,
      count: item.trade_count ?? 0,
      avgProfit: item.avg_profit ?? 0,
      avgLoss: item.avg_loss ?? 0,
      profitablePct: item.profitable_pct ?? 0,
    }))

    // 格式化月度表现
    const monthlyPerformance = monthlyData.map((item: { year: number; month: number; roi: number | null }) => ({
      month: `${item.year}-${String(item.month).padStart(2, '0')}`,
      value: item.roi ?? 0,
    }))

    // 格式化年度表现
    const yearlyPerformance = yearlyData.map((item: { year: number; roi: number | null }) => ({
      year: item.year,
      value: item.roi ?? 0,
    }))

    return {
      expectedDividends: undefined,
      trading: latestSnapshot ? {
        totalTrades12M: latestSnapshot.trades_count ?? 0,
        avgProfit: 0,
        avgLoss: 0,
        profitableTradesPct: latestSnapshot.win_rate ?? 0,
      } : undefined,
      frequentlyTraded: frequentlyTraded.length > 0 ? frequentlyTraded : undefined,
      additionalStats: {
        tradesPerWeek: undefined,
        avgHoldingTime: latestSnapshot?.holding_days ? `${latestSnapshot.holding_days}天` : undefined,
        activeSince,
        profitableWeeksPct,
        riskScore: undefined,
        volume90d: undefined,
        maxDrawdown: latestSnapshot?.max_drawdown ?? undefined,
        sharpeRatio: undefined,
      },
      monthlyPerformance: monthlyPerformance.length > 0 ? monthlyPerformance : undefined,
      yearlyPerformance: yearlyPerformance.length > 0 ? yearlyPerformance : undefined,
    }
  } catch (error) {
    const logger = createLogger('trader-data')
    logger.error('Error in getTraderStats', { error, handle })
    return { additionalStats: {} }
  }
}

/**
 * 获取交易员频繁交易资产
 */
export async function getTraderFrequentlyTraded(handle: string): Promise<Array<{
  symbol: string
  weightPct: number
  count: number
  avgProfit: number
  avgLoss: number
  profitablePct: number
}>> {
  try {
    const source = await findTraderAcrossSources(handle)
    if (!source) return []

    // 获取最新的 captured_at
    const { data: latestSnapshot } = await supabase
      .from('trader_snapshots')
      .select('captured_at')
      .eq('source', source.source)
      .eq('source_trader_id', source.source_trader_id)
      .order('captured_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (!latestSnapshot) return []

    const { data } = await supabase
      .from('trader_frequently_traded')
      .select('symbol, weight_pct, trade_count, avg_profit, avg_loss, profitable_pct')
      .eq('source', source.source)
      .eq('source_trader_id', source.source_trader_id)
      .eq('captured_at', latestSnapshot.captured_at)
      .order('weight_pct', { ascending: false })
      .limit(10)

    if (!data) return []

    return data.map((item: {
      symbol: string
      weight_pct: number | null
      trade_count: number | null
      avg_profit: number | null
      avg_loss: number | null
      profitable_pct: number | null
    }) => ({
      symbol: item.symbol,
      weightPct: item.weight_pct ?? 0,
      count: item.trade_count ?? 0,
      avgProfit: item.avg_profit ?? 0,
      avgLoss: item.avg_loss ?? 0,
      profitablePct: item.profitable_pct ?? 0,
    }))
  } catch (error) {
    const logger = createLogger('trader-data')
    logger.error('Error in getTraderFrequentlyTraded', { error, handle })
    return []
  }
}

/**
 * 获取交易员月度表现
 */
export async function getTraderMonthlyPerformance(handle: string): Promise<Array<{ month: string; value: number }>> {
  try {
    const source = await findTraderAcrossSources(handle)
    if (!source) return []

    const { data } = await supabase
      .from('trader_monthly_performance')
      .select('year, month, roi')
      .eq('source', source.source)
      .eq('source_trader_id', source.source_trader_id)
      .order('year', { ascending: false })
      .order('month', { ascending: false })
      .limit(12)

    if (!data) return []

    return data.map((item: { year: number; month: number; roi: number | null }) => ({
      month: `${item.year}-${String(item.month).padStart(2, '0')}`,
      value: item.roi ?? 0,
    }))
  } catch (error) {
    const logger = createLogger('trader-data')
    logger.error('Error in getTraderMonthlyPerformance', { error, handle })
    return []
  }
}

/**
 * 获取交易员年度表现
 */
export async function getTraderYearlyPerformance(handle: string): Promise<Array<{ year: number; value: number }>> {
  try {
    const source = await findTraderAcrossSources(handle)
    if (!source) return []

    const { data } = await supabase
      .from('trader_yearly_performance')
      .select('year, roi')
      .eq('source', source.source)
      .eq('source_trader_id', source.source_trader_id)
      .order('year', { ascending: false })
      .limit(5)

    if (!data) return []

    return data.map((item: { year: number; roi: number | null }) => ({
      year: item.year,
      value: item.roi ?? 0,
    }))
  } catch (error) {
    const logger = createLogger('trader-data')
    logger.error('Error in getTraderYearlyPerformance', { error, handle })
    return []
  }
}

/**
 * 获取交易员投资组合
 */
export async function getTraderPortfolio(handle: string): Promise<PortfolioItem[]> {
  try {
    const source = await findTraderAcrossSources(handle)
    if (!source) return []

    const { data } = await supabase
      .from('trader_portfolio')
      .select('symbol, direction, weight_pct, entry_price, pnl_pct')
      .eq('source', source.source)
      .eq('source_trader_id', source.source_trader_id)
      .order('updated_at', { ascending: false })
      .limit(100)

    if (!data) return []

    return data.map((item: {
      symbol: string | null
      direction: string | null
      weight_pct: number | null
      entry_price: number | null
      pnl_pct: number | null
    }) => ({
      market: item.symbol || '',
      direction: (item.direction === 'long' || item.direction === 'short') ? item.direction : 'long',
      invested: item.weight_pct ?? 0,
      pnl: item.pnl_pct ?? 0,
      value: item.weight_pct ?? 0,
      price: item.entry_price ?? 0,
      priceChange: undefined,
    }))
  } catch (error) {
    const logger = createLogger('trader-data')
    logger.error('Error in getTraderPortfolio', { error, handle })
    return []
  }
}

/**
 * 获取交易员历史订单
 */
export async function getTraderPositionHistory(handle: string): Promise<PositionHistoryItem[]> {
  try {
    const source = await findTraderAcrossSources(handle, { includeWeb3: false })
    if (!source) return []

    const { data } = await supabase
      .from('trader_position_history')
      .select('symbol, direction, entry_price, exit_price, pnl_pct, open_time, close_time')
      .eq('source', source.source)
      .eq('source_trader_id', source.source_trader_id)
      .order('close_time', { ascending: false })
      .limit(50)

    if (!data) return []

    return data.map((item: {
      symbol: string | null
      direction: string | null
      entry_price: number | null
      exit_price: number | null
      pnl_pct: number | null
      open_time: string | null
      close_time: string | null
    }) => ({
      symbol: item.symbol || '',
      direction: item.direction === 'short' ? 'short' : 'long',
      entryPrice: item.entry_price || 0,
      exitPrice: item.exit_price || 0,
      pnlPct: item.pnl_pct || 0,
      openTime: item.open_time || '',
      closeTime: item.close_time || '',
    }))
  } catch (error) {
    const logger = createLogger('trader-data')
    logger.error('Error in getTraderPositionHistory', { error, handle })
    return []
  }
}

/**
 * 获取交易员动态 feed
 */
export async function getTraderFeed(handle: string): Promise<TraderFeedItem[]> {
  try {
    const decodedHandle = decodeURIComponent(handle)

    // 并行获取帖子、用户资料和转发
    const [postsResult, userProfileResult] = await Promise.all([
      // 获取帖子
      supabase
        .from('posts')
        .select('id, title, content, created_at, group_id, like_count, is_pinned, groups(name)')
        .or(`author_handle.eq.${handle},author_handle.eq.${decodedHandle}`)
        .order('created_at', { ascending: false })
        .limit(20),
      // 获取用户 ID
      supabase
        .from('user_profiles')
        .select('id')
        .or(`handle.eq.${handle},handle.eq.${decodedHandle}`)
        .limit(1)
        .maybeSingle(),
    ])

    const posts = postsResult.data || []
    const userProfile = userProfileResult.data

    // 如果有用户，获取转发
    let repostsData: unknown[] = []
    
    if (userProfile?.id) {
      const { data } = await supabase
        .from('reposts')
        .select(`
          id,
          comment,
          created_at,
          post_id,
          posts (
            id,
            title,
            content,
            author_handle,
            group_id,
            like_count,
            groups (name)
          )
        `)
        .eq('user_id', userProfile.id)
        .order('created_at', { ascending: false })
        .limit(20)
      
      if (data) repostsData = data
    }

    // 合并帖子
    const feedItems: TraderFeedItem[] = posts.map((post) => {
      const p = post as Record<string, unknown>
      const groups = p.groups as Array<{ name: string }> | null
      return {
        id: String(p.id),
        type: p.group_id ? 'group_post' as const : 'post' as const,
        title: String(p.title || ''),
        content: String(p.content || ''),
        time: String(p.created_at),
        groupId: p.group_id ? String(p.group_id) : undefined,
        groupName: groups?.[0]?.name,
        like_count: Number(p.like_count) || 0,
        is_pinned: Boolean(p.is_pinned),
      }
    })

    // 添加转发
    repostsData.forEach((repost) => {
      const r = repost as Record<string, unknown>
      // Supabase 一对一关联返回单个对象，不是数组
      const postData = r.posts as Record<string, unknown> | null
      
      if (postData) {
        const groups = postData.groups as { name: string } | null
        feedItems.push({
          id: `repost-${r.id}`,
          type: 'repost',
          title: String(postData.title || ''),
          content: String(postData.content || ''),
          time: String(r.created_at),
          groupId: postData.group_id ? String(postData.group_id) : undefined,
          groupName: groups?.name,
          like_count: Number(postData.like_count) || 0,
          is_pinned: false,
          repost_comment: r.comment ? String(r.comment) : undefined,
          original_author_handle: String(postData.author_handle || ''),
          original_post_id: String(postData.id),
        })
      }
    })

    // 按时间排序
    feedItems.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime())

    return feedItems
  } catch (error) {
    const logger = createLogger('trader-data')
    logger.error('Error fetching trader feed', { error, handle })
    return []
  }
}

/**
 * 获取相似交易员
 * 优化版本：减少数据库查询次数
 */
export async function getSimilarTraders(handle: string, limit: number = 6): Promise<TraderProfile[]> {
  try {
    const source = await findTraderAcrossSources(handle)
    if (!source) return []

    // 获取最新快照时间和当前交易员 ROI
    const { data: latestSnapshot } = await supabase
      .from('trader_snapshots')
      .select('captured_at, roi')
      .eq('source', source.source)
      .order('captured_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (!latestSnapshot) return []

    // 获取当前交易员 ROI
    const { data: currentRoiData } = await supabase
      .from('trader_snapshots')
      .select('roi')
      .eq('source', source.source)
      .eq('source_trader_id', source.source_trader_id)
      .order('captured_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    const currentRoi = currentRoiData?.roi ?? 0
    const roiRange = Math.max(Math.abs(currentRoi) * 0.3, 20)
    const minRoi = currentRoi - roiRange
    const maxRoi = currentRoi + roiRange

    // 获取相似 ROI 的交易员
    let { data: snapshots } = await supabase
      .from('trader_snapshots')
      .select('source_trader_id, roi')
      .eq('source', source.source)
      .eq('captured_at', latestSnapshot.captured_at)
      .neq('source_trader_id', source.source_trader_id)
      .gte('roi', minRoi)
      .lte('roi', maxRoi)
      .limit(50)

    // 如果没有相似的，获取 ROI 最高的
    if (!snapshots || snapshots.length === 0) {
      const { data: fallback } = await supabase
        .from('trader_snapshots')
        .select('source_trader_id, roi')
        .eq('source', source.source)
        .eq('captured_at', latestSnapshot.captured_at)
        .neq('source_trader_id', source.source_trader_id)
        .order('roi', { ascending: false })
        .limit(limit)
      
      snapshots = fallback
    }

    if (!snapshots || snapshots.length === 0) return []

    // 按 ROI 差距排序
    const sortedSnapshots = snapshots
      .map(s => ({ ...s, diff: Math.abs((s.roi || 0) - currentRoi) }))
      .sort((a, b) => a.diff - b.diff)
      .slice(0, limit)

    // 批量获取交易员信息
    const traderIds = sortedSnapshots.map(s => s.source_trader_id)
    
    const [sourcesResult, followersMap] = await Promise.all([
      supabase
        .from('trader_sources')
        .select('source_trader_id, handle, profile_url')
        .eq('source', source.source)
        .in('source_trader_id', traderIds),
      getTraderArenaFollowersCountBatch(supabase, traderIds),
    ])

    const handleMap = new Map<string, { handle: string; profile_url: string | null }>()
    if (sourcesResult.data) {
      sourcesResult.data.forEach((s: { source_trader_id: string; handle: string | null; profile_url: string | null }) => {
        handleMap.set(s.source_trader_id, {
          handle: s.handle || s.source_trader_id,
          profile_url: s.profile_url,
        })
      })
    }

    return sortedSnapshots.map(s => {
      const info = handleMap.get(s.source_trader_id) || { handle: s.source_trader_id, profile_url: null }
      return {
        handle: info.handle,
        id: s.source_trader_id,
        followers: followersMap.get(s.source_trader_id) || 0,
        avatar_url: info.profile_url || undefined,
        source: source.source,
      }
    })
  } catch (error) {
    const logger = createLogger('trader-data')
    logger.error('Error fetching similar traders', { error, handle })
    return []
  }
}
