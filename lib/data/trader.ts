/**
 * Trader Data Adapter
 * 数据适配层 - 从 Supabase 获取交易员数据，缺失字段使用 mock
 */

import { supabase } from '@/lib/supabase/client'

// 支持的交易所数据源
const TRADER_SOURCES = ['binance', 'bybit', 'bitget', 'okx', 'kucoin', 'gate', 'mexc', 'coinex'] as const
const TRADER_SOURCES_WITH_WEB3 = ['binance_web3', ...TRADER_SOURCES] as const

interface TraderSourceResult {
  source_trader_id: string
  handle: string | null
  profile_url: string | null
  sourceType: string
}

/**
 * 通用的交易员数据源查找函数
 * 遍历所有数据源，尝试通过 handle 或 source_trader_id 找到交易员
 */
async function findTraderSource(
  handle: string,
  options: { includeWeb3?: boolean; selectFields?: string } = {}
): Promise<TraderSourceResult | null> {
  const { includeWeb3 = false, selectFields = 'source_trader_id, handle, profile_url' } = options
  const decodedHandle = decodeURIComponent(handle)
  const sources = includeWeb3 ? TRADER_SOURCES_WITH_WEB3 : TRADER_SOURCES

  for (const sourceType of sources) {
    // 尝试按 handle 查询
    const { data: byHandle } = await supabase
      .from('trader_sources')
      .select(selectFields)
      .eq('source', sourceType)
      .eq('handle', handle)
      .limit(1)
      .maybeSingle()

    if (byHandle && typeof byHandle === 'object') {
      const result = byHandle as { source_trader_id: string; handle: string | null; profile_url: string | null }
      return { ...result, sourceType }
    }

    // 尝试解码后的 handle
    if (decodedHandle !== handle) {
      const { data: byDecodedHandle } = await supabase
        .from('trader_sources')
        .select(selectFields)
        .eq('source', sourceType)
        .eq('handle', decodedHandle)
        .limit(1)
        .maybeSingle()

      if (byDecodedHandle && typeof byDecodedHandle === 'object') {
        const result = byDecodedHandle as { source_trader_id: string; handle: string | null; profile_url: string | null }
        return { ...result, sourceType }
      }
    }

    // 尝试作为 source_trader_id 查询
    const { data: byId } = await supabase
      .from('trader_sources')
      .select(selectFields)
      .eq('source', sourceType)
      .eq('source_trader_id', handle)
      .limit(1)
      .maybeSingle()

    if (byId && typeof byId === 'object') {
      const result = byId as { source_trader_id: string; handle: string | null; profile_url: string | null }
      return { ...result, sourceType }
    }

    // 尝试解码后的 handle 作为 source_trader_id
    if (decodedHandle !== handle) {
      const { data: byDecodedId } = await supabase
        .from('trader_sources')
        .select(selectFields)
        .eq('source', sourceType)
        .eq('source_trader_id', decodedHandle)
        .limit(1)
        .maybeSingle()

      if (byDecodedId && typeof byDecodedId === 'object') {
        const result = byDecodedId as { source_trader_id: string; handle: string | null; profile_url: string | null }
        return { ...result, sourceType }
      }
    }
  }

  return null
}

export interface TraderProfile {
  handle: string
  id: string
  bio?: string
  followers?: number // 关注他的人数量（粉丝数）
  following?: number // 他关注的人数量
  copiers?: number
  avatar_url?: string
  isRegistered?: boolean // 是否在平台注册
  source?: string // 数据来源：binance, bybit, okx等
}

export interface TraderPerformance {
  // public_snapshot_*: 公开榜单快照数据（直接从交易所公开 API 抓取）
  roi_7d?: number // public_snapshot_roi_7d
  roi_30d?: number // public_snapshot_roi_30d
  roi_90d?: number // public_snapshot_roi_90d
  roi_1y?: number // public_snapshot_roi_1y
  roi_2y?: number // public_snapshot_roi_2y
  return_ytd?: number // public_snapshot_return_ytd
  return_2y?: number // public_snapshot_return_2y
  
  // 关键指标 (90D)
  pnl?: number // 盈亏金额 (90D)
  win_rate?: number // 胜率（百分比）(90D)
  max_drawdown?: number // 最大回撤（百分比）(90D)
  
  // 7D/30D 详细数据
  pnl_7d?: number
  pnl_30d?: number
  win_rate_7d?: number
  win_rate_30d?: number
  max_drawdown_7d?: number
  max_drawdown_30d?: number
  
  // derived_from_snapshot_*: 基于快照计算的数据（从公开快照派生）
  risk_score_last_7d?: number // derived_from_snapshot_risk_score
  profitable_weeks?: number // derived_from_snapshot_profitable_weeks
  monthlyPerformance?: Array<{ month: string; value: number }> // derived_from_snapshot_monthly_performance
  yearlyPerformance?: Array<{ year: number; value: number }> // derived_from_snapshot_yearly_performance
}

export interface TraderStats {
  // account_required_*: 绑定账户后解锁的数据（需要用户授权访问私有交易数据）
  expectedDividends?: { // account_required_expected_dividends
    dividendYield: number
    assets: number
    trendingStocks: Array<{
      symbol: string
      yield: number
      icon?: string
    }>
  }
  trading?: { // account_required_trading_stats
    totalTrades12M: number
    avgProfit: number
    avgLoss: number
    profitableTradesPct: number
  }
  frequentlyTraded?: Array<{ // account_required_frequently_traded
    symbol: string
    weightPct: number
    count: number
    avgProfit: number
    avgLoss: number
    profitablePct: number
  }>
  
  // derived_from_snapshot_*: 基于快照计算的数据（从公开快照派生）
  additionalStats?: { // derived_from_snapshot_additional_stats
    tradesPerWeek?: number // derived_from_snapshot_trades_per_week
    avgHoldingTime?: string // derived_from_snapshot_avg_holding_time
    activeSince?: string // public_snapshot_first_seen_at (首次在 Arena 发现的时间)
    profitableWeeksPct?: number // derived_from_snapshot_profitable_weeks_pct
    riskScore?: number // risk_score from snapshot
    volume90d?: number // volume_90d from snapshot
    maxDrawdown?: number // max_drawdown from snapshot
    sharpeRatio?: number // sharpe_ratio from snapshot
  }
  monthlyPerformance?: Array<{ month: string; value: number }> // derived_from_snapshot_monthly_performance
  yearlyPerformance?: Array<{ year: number; value: number }> // derived_from_snapshot_yearly_performance
}

export interface PortfolioItem {
  market: string
  direction: 'long' | 'short'
  invested: number // percentage
  pnl: number // percentage
  value: number // percentage
  price: number
  priceChange?: number
  priceChangePct?: number
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
  // 转发相关
  repost_comment?: string
  original_author_handle?: string
  original_post_id?: string
}

/**
 * 根据 handle 获取交易员基本信息
 */
export async function getTraderByHandle(handle: string): Promise<TraderProfile | null> {
  if (!handle) return null

  try {
    // 解码 URL 编码的 handle
    const decodedHandle = decodeURIComponent(handle)
    
    // 检查所有数据源
    const sources = ['binance', 'bybit', 'bitget', 'okx', 'kucoin', 'gate', 'mexc', 'coinex']
    
    for (const sourceType of sources) {
      // 从 trader_sources 表获取交易员信息（只查询 profile_url，因为 avatar_url 列不存在）
      // 注意：可能有多条匹配记录，需要找到有快照数据的那条
      let source = null
      let candidateSources: Array<{ source_trader_id: string; handle: string | null; profile_url: string | null }> = []
      
      // 尝试用原始 handle 查询
      const { data: sources1 } = await supabase
        .from('trader_sources')
        .select('source_trader_id, handle, profile_url')
        .eq('source', sourceType)
        .eq('handle', handle)
      
      if (sources1 && sources1.length > 0) {
        candidateSources = sources1
      }
      
      // 如果原始 handle 找不到，尝试解码后的 handle（如果不同）
      if (candidateSources.length === 0 && decodedHandle !== handle) {
        const { data: sources2 } = await supabase
          .from('trader_sources')
          .select('source_trader_id, handle, profile_url')
          .eq('source', sourceType)
          .eq('handle', decodedHandle)
        
        if (sources2 && sources2.length > 0) {
          candidateSources = sources2
        }
      }

      if (candidateSources.length === 0) {
        // 如果 handle 匹配不到，尝试用 handle 或 decodedHandle 作为 source_trader_id 查询
        const { data: sourcesById1 } = await supabase
          .from('trader_sources')
          .select('source_trader_id, handle, profile_url')
          .eq('source', sourceType)
          .eq('source_trader_id', handle)
        
        if (sourcesById1 && sourcesById1.length > 0) {
          candidateSources = sourcesById1
        } else if (decodedHandle !== handle) {
          const { data: sourcesById2 } = await supabase
            .from('trader_sources')
            .select('source_trader_id, handle, profile_url')
            .eq('source', sourceType)
            .eq('source_trader_id', decodedHandle)
          
          if (sourcesById2 && sourcesById2.length > 0) {
            candidateSources = sourcesById2
          }
        }
      }
      
      // 如果有多个候选记录，找到有快照数据的那条
      if (candidateSources.length > 1) {
        for (const candidate of candidateSources) {
          const { data: snapshot } = await supabase
            .from('trader_snapshots')
            .select('id')
            .eq('source', sourceType)
            .eq('source_trader_id', candidate.source_trader_id)
            .limit(1)
          
          if (snapshot && snapshot.length > 0) {
            source = candidate
            break
          }
        }
        // 如果没有找到有快照的，使用第一个
        if (!source) {
          source = candidateSources[0]
        }
      } else if (candidateSources.length === 1) {
        source = candidateSources[0]
      }
      
      if (!source) {
        continue
      }

      // 获取 Arena 粉丝数（从 trader_follows 表统计）
      // 注意：不再从 trader_snapshots 获取 followers，所有 trader 的粉丝数只能来源 Arena 注册用户的关注
      const { getTraderArenaFollowersCount } = await import('./trader-followers')
      const arenaFollowersCount = await getTraderArenaFollowersCount(supabase, source.source_trader_id)

      // 检查是否在平台注册（从 user_profiles 表，不查询 avatar_url，因为永远使用 trader 的原始头像）
      const profileHandle = source.handle || source.source_trader_id
      // 尝试多个可能的 handle 值，只查询 bio 用于显示，不查询 avatar_url
      const { data: profile1 } = await supabase
        .from('user_profiles')
        .select('id, bio')
        .eq('handle', profileHandle)
        .maybeSingle()
      
      let profile = profile1
      if (!profile && decodedHandle !== handle) {
        const { data: profile2 } = await supabase
          .from('user_profiles')
          .select('id, bio')
          .eq('handle', decodedHandle)
          .maybeSingle()
        if (profile2) profile = profile2
      }
      if (!profile && handle !== profileHandle) {
        const { data: profile3 } = await supabase
          .from('user_profiles')
          .select('id, bio')
          .eq('handle', handle)
          .maybeSingle()
        if (profile3) profile = profile3
      }

      console.log(`[trader] Found trader: ${source.handle || source.source_trader_id} (source: ${sourceType}, arena followers: ${arenaFollowersCount})`)
      // 永远只使用 trader_sources 中的 profile_url（这是trader在交易所的原始头像URL）
      // 注意：avatar_url 列不存在，所以只使用 profile_url
      // 不使用用户设置的 avatar_url，确保永远显示 trader 在交易所的原始头像
      const traderAvatarUrl = source.profile_url || undefined
      return {
        handle: source.handle || source.source_trader_id,
        id: source.source_trader_id,
        bio: profile?.bio || undefined,
        followers: arenaFollowersCount, // 使用 Arena 粉丝数（从 trader_follows 表统计）
        copiers: 0,
        avatar_url: traderAvatarUrl, // 永远只使用 trader 的原始头像，不使用 profile?.avatar_url
        isRegistered: !!profile,
        source: sourceType,
      }
    }

    console.warn(`[trader] No trader found for handle: ${handle} (decoded: ${decodedHandle})`)
    return null
  } catch (error) {
    console.error('[trader] Error in getTraderByHandle:', error)
    return null
  }
}

/**
 * 获取交易员绩效数据
 */
export async function getTraderPerformance(handle: string, period: '7D' | '30D' | '90D' | '1Y' | '2Y' | 'All' = '90D'): Promise<TraderPerformance> {
  try {
    void period
    // 解码 URL 编码的 handle
    const decodedHandle = decodeURIComponent(handle)
    
    // 尝试所有数据源：binance_web3, binance, bybit, bitget, mexc, coinex, okx, kucoin, gate
    const sources = ['binance_web3', 'binance', 'bybit', 'bitget', 'mexc', 'coinex', 'okx', 'kucoin', 'gate']
    
    for (const sourceType of sources) {
      // 先获取所有匹配的 source_trader_id（可能有多条）
      let candidateSources: Array<{ source_trader_id: string }> = []
      
      const { data: sources1 } = await supabase
        .from('trader_sources')
        .select('source_trader_id')
        .eq('source', sourceType)
        .eq('handle', handle)
        .limit(10)
      
      if (sources1 && sources1.length > 0) {
        candidateSources = sources1
      }
      
      // 如果原始 handle 找不到，尝试解码后的 handle
      if (candidateSources.length === 0 && decodedHandle !== handle) {
        const { data: sources2 } = await supabase
          .from('trader_sources')
          .select('source_trader_id')
          .eq('source', sourceType)
          .eq('handle', decodedHandle)
          .limit(10)
        if (sources2 && sources2.length > 0) {
          candidateSources = sources2
        }
      }
      
      // 如果 handle 找不到，尝试作为 source_trader_id
      if (candidateSources.length === 0) {
        const { data: sources3 } = await supabase
          .from('trader_sources')
          .select('source_trader_id')
          .eq('source', sourceType)
          .eq('source_trader_id', handle)
          .limit(10)
        if (sources3 && sources3.length > 0) {
          candidateSources = sources3
        }
      }

      if (candidateSources.length === 0) {
        continue
      }

      // 遍历所有候选记录，找到有快照数据的那条
      for (const candidate of candidateSources) {
        // 获取最新快照（只查询存在的列）
        const { data: latestSnapshot, error: snapshotError } = await supabase
          .from('trader_snapshots')
          .select('roi, pnl, win_rate, max_drawdown, season_id')
          .eq('source', sourceType)
          .eq('source_trader_id', candidate.source_trader_id)
          .or('season_id.is.null,season_id.eq.90D')
          .order('captured_at', { ascending: false })
          .limit(1)
          .maybeSingle()
        
        if (snapshotError) {
          console.error(`[getTraderPerformance] 查询错误:`, snapshotError.message)
          continue
        }

        // 如果没有数据，尝试下一个候选
        if (!latestSnapshot || latestSnapshot.roi === null) {
          continue
        }

        // 从 season_id 行获取 7D/30D 数据
        // 获取7D数据
        const { data: snapshot7d } = await supabase
          .from('trader_snapshots')
          .select('roi, pnl, win_rate, max_drawdown')
          .eq('source', sourceType)
          .eq('source_trader_id', candidate.source_trader_id)
          .eq('season_id', '7D')
          .order('captured_at', { ascending: false })
          .limit(1)
          .maybeSingle()

        // 获取30D数据
        const { data: snapshot30d } = await supabase
          .from('trader_snapshots')
          .select('roi, pnl, win_rate, max_drawdown')
          .eq('source', sourceType)
          .eq('source_trader_id', candidate.source_trader_id)
          .eq('season_id', '30D')
          .order('captured_at', { ascending: false })
          .limit(1)
          .maybeSingle()

        // 返回所有时间段的数据
        const result = {
          roi_90d: latestSnapshot.roi || 0,
          roi_7d: snapshot7d?.roi ?? undefined,
          roi_30d: snapshot30d?.roi ?? undefined,
          pnl: latestSnapshot.pnl ?? undefined,
          win_rate: latestSnapshot.win_rate ?? undefined,
          max_drawdown: latestSnapshot.max_drawdown ?? undefined,
          pnl_7d: snapshot7d?.pnl ?? undefined,
          pnl_30d: snapshot30d?.pnl ?? undefined,
          win_rate_7d: snapshot7d?.win_rate ?? undefined,
          win_rate_30d: snapshot30d?.win_rate ?? undefined,
          max_drawdown_7d: snapshot7d?.max_drawdown ?? undefined,
          max_drawdown_30d: snapshot30d?.max_drawdown ?? undefined,
          roi_1y: undefined,
          roi_2y: undefined,
        }
        return result
      }
    }

    // 如果没有找到，返回空对象
    return {
      roi_90d: 0,
    }
  } catch (error) {
    console.error('Error in getTraderPerformance:', error)
    return {
      roi_90d: 0,
    }
  }
}

/**
 * 获取交易员统计数据
 */
export async function getTraderStats(handle: string): Promise<TraderStats> {
  try {
    // 解码 URL 编码的 handle
    const decodedHandle = decodeURIComponent(handle)
    
    // 尝试所有数据源：binance_web3, binance, bybit, bitget, mexc, coinex, okx, kucoin, gate
    const sources = ['binance_web3', 'binance', 'bybit', 'bitget', 'mexc', 'coinex', 'okx', 'kucoin', 'gate']
    
    for (const sourceType of sources) {
      // 先获取所有匹配的 source_trader_id（可能有多条）
      let candidateSources: Array<{ source_trader_id: string }> = []
      
      const { data: sources1 } = await supabase
        .from('trader_sources')
        .select('source_trader_id')
        .eq('source', sourceType)
        .eq('handle', handle)
        .limit(10)
      
      if (sources1 && sources1.length > 0) {
        candidateSources = sources1
      }
      
      // 如果原始 handle 找不到，尝试解码后的 handle
      if (candidateSources.length === 0 && decodedHandle !== handle) {
        const { data: sources2 } = await supabase
          .from('trader_sources')
          .select('source_trader_id')
          .eq('source', sourceType)
          .eq('handle', decodedHandle)
          .limit(10)
        if (sources2 && sources2.length > 0) {
          candidateSources = sources2
        }
      }
      
      // 如果 handle 找不到，尝试作为 source_trader_id
      if (candidateSources.length === 0) {
        const { data: sources3 } = await supabase
          .from('trader_sources')
          .select('source_trader_id')
          .eq('source', sourceType)
          .eq('source_trader_id', handle)
          .limit(10)
        if (sources3 && sources3.length > 0) {
          candidateSources = sources3
        }
      }

      if (candidateSources.length === 0) {
        continue
      }

      // 遍历所有候选记录，找到有快照数据的那条
      for (const candidate of candidateSources) {
        // 获取最新的快照数据
        const { data: latestSnapshot } = await supabase
          .from('trader_snapshots')
          .select('roi, captured_at, pnl, win_rate, max_drawdown, trades_count, holding_days')
          .eq('source', sourceType)
          .eq('source_trader_id', candidate.source_trader_id)
          .order('captured_at', { ascending: false })
          .limit(1)
          .maybeSingle()

        // 获取历史快照数据用于计算
        const { data: snapshots } = await supabase
          .from('trader_snapshots')
          .select('roi, captured_at')
          .eq('source', sourceType)
          .eq('source_trader_id', candidate.source_trader_id)
          .order('captured_at', { ascending: true })

        if (!snapshots || snapshots.length === 0) {
          continue // 尝试下一个候选记录
        }
        
        // 找到有数据的记录，继续处理

        // 计算 activeSince（最早的 captured_at）
        const earliestSnapshot = snapshots[0]
        const activeSinceDate = new Date(earliestSnapshot.captured_at)
        const activeSince = `${activeSinceDate.getMonth() + 1}/${activeSinceDate.getDate()}/${activeSinceDate.getFullYear().toString().slice(-2)}`

        // 计算 profitableWeeksPct（如果有多个时间点的数据）
        let profitableWeeksPct: number | undefined = undefined
        if (snapshots.length > 1) {
          const profitableWeeks = snapshots.filter(s => (s.roi || 0) > 0).length
          profitableWeeksPct = (profitableWeeks / snapshots.length) * 100
        }

        // 获取频繁交易资产
        const frequentlyTraded = await getTraderFrequentlyTraded(handle)

        // 获取月度表现
        const monthlyPerformance = await getTraderMonthlyPerformance(handle)

        // 获取年度表现
        const yearlyPerformance = await getTraderYearlyPerformance(handle)

        // 返回可计算的数据
        // 使用数据库中实际存在的列
        return {
          // account_required_* 字段需要绑定账户，返回undefined
          expectedDividends: undefined,
          trading: latestSnapshot ? {
            totalTrades12M: latestSnapshot.trades_count ?? 0,
            avgProfit: 0, // 数据库中没有此列
            avgLoss: 0, // 数据库中没有此列
            profitableTradesPct: latestSnapshot.win_rate ?? 0, // 使用 win_rate 作为替代
          } : undefined,
          frequentlyTraded: frequentlyTraded.length > 0 ? frequentlyTraded : undefined,
          // derived_from_snapshot_* 字段
          additionalStats: {
            tradesPerWeek: undefined, // 数据库中没有此列
            avgHoldingTime: latestSnapshot?.holding_days ? `${latestSnapshot.holding_days}天` : undefined,
            activeSince, // 可以从最早快照计算
            profitableWeeksPct, // 可以从历史快照计算
            riskScore: undefined, // 数据库中没有此列
            volume90d: undefined, // 数据库中没有此列
            maxDrawdown: latestSnapshot?.max_drawdown ?? undefined, // 已有此列
            sharpeRatio: undefined, // 数据库中没有此列
          },
          monthlyPerformance: monthlyPerformance.length > 0 ? monthlyPerformance : undefined,
          yearlyPerformance: yearlyPerformance.length > 0 ? yearlyPerformance : undefined,
        }
      } // end of for (const candidate of candidateSources)
    } // end of for (const sourceType of sources)

    // 如果没有找到，返回空对象
    return {
      additionalStats: {
        tradesPerWeek: undefined,
        avgHoldingTime: undefined,
        activeSince: undefined,
        profitableWeeksPct: undefined,
      },
    }
  } catch (error) {
    console.error('Error in getTraderStats:', error)
    return {
      additionalStats: {
        tradesPerWeek: undefined,
        avgHoldingTime: undefined,
        activeSince: undefined,
        profitableWeeksPct: undefined,
      },
    }
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
    const decodedHandle = decodeURIComponent(handle)
    const sources = ['binance_web3', 'binance', 'bybit', 'bitget', 'mexc', 'coinex', 'okx', 'kucoin', 'gate']
    
    for (const sourceType of sources) {
      let source = null
      const { data: source1 } = await supabase
        .from('trader_sources')
        .select('source_trader_id')
        .eq('source', sourceType)
        .eq('handle', handle)
        .maybeSingle()
      
      if (source1) {
        source = source1
      } else if (decodedHandle !== handle) {
        const { data: source2 } = await supabase
          .from('trader_sources')
          .select('source_trader_id')
          .eq('source', sourceType)
          .eq('handle', decodedHandle)
          .maybeSingle()
        if (source2) source = source2
      }
      
      if (!source) {
        const { data: source3 } = await supabase
          .from('trader_sources')
          .select('source_trader_id')
          .eq('source', sourceType)
          .eq('source_trader_id', handle)
          .maybeSingle()
        if (source3) source = source3
      }
      
      if (!source) continue

      // 获取最新的频繁交易资产数据
      const { data: latestSnapshot } = await supabase
        .from('trader_snapshots')
        .select('captured_at')
        .eq('source', sourceType)
        .eq('source_trader_id', source.source_trader_id)
        .order('captured_at', { ascending: false })
        .limit(1)
        .maybeSingle()

      if (!latestSnapshot) continue

      const { data: frequentlyTraded } = await supabase
        .from('trader_frequently_traded')
        .select('symbol, weight_pct, trade_count, avg_profit, avg_loss, profitable_pct')
        .eq('source', sourceType)
        .eq('source_trader_id', source.source_trader_id)
        .eq('captured_at', latestSnapshot.captured_at)
        .order('weight_pct', { ascending: false })
        .limit(10)

      if (frequentlyTraded && frequentlyTraded.length > 0) {
        return frequentlyTraded.map((item: any) => ({
          symbol: item.symbol,
          weightPct: item.weight_pct ?? 0,
          count: item.trade_count ?? 0,
          avgProfit: item.avg_profit ?? 0,
          avgLoss: item.avg_loss ?? 0,
          profitablePct: item.profitable_pct ?? 0,
        }))
      }
    }

    return []
  } catch (error) {
    console.error('Error in getTraderFrequentlyTraded:', error)
    return []
  }
}

/**
 * 获取交易员月度表现
 */
export async function getTraderMonthlyPerformance(handle: string): Promise<Array<{ month: string; value: number }>> {
  try {
    const decodedHandle = decodeURIComponent(handle)
    const sources = ['binance_web3', 'binance', 'bybit', 'bitget', 'mexc', 'coinex', 'okx', 'kucoin', 'gate']
    
    for (const sourceType of sources) {
      let source = null
      const { data: source1 } = await supabase
        .from('trader_sources')
        .select('source_trader_id')
        .eq('source', sourceType)
        .eq('handle', handle)
        .maybeSingle()
      
      if (source1) {
        source = source1
      } else if (decodedHandle !== handle) {
        const { data: source2 } = await supabase
          .from('trader_sources')
          .select('source_trader_id')
          .eq('source', sourceType)
          .eq('handle', decodedHandle)
          .maybeSingle()
        if (source2) source = source2
      }
      
      if (!source) {
        const { data: source3 } = await supabase
          .from('trader_sources')
          .select('source_trader_id')
          .eq('source', sourceType)
          .eq('source_trader_id', handle)
          .maybeSingle()
        if (source3) source = source3
      }
      
      if (!source) continue

      // 获取最近12个月的月度表现
      const { data: monthlyData } = await supabase
        .from('trader_monthly_performance')
        .select('year, month, roi')
        .eq('source', sourceType)
        .eq('source_trader_id', source.source_trader_id)
        .order('year', { ascending: false })
        .order('month', { ascending: false })
        .limit(12)

      if (monthlyData && monthlyData.length > 0) {
        return monthlyData.map((item: any) => ({
          month: `${item.year}-${String(item.month).padStart(2, '0')}`,
          value: item.roi ?? 0,
        }))
      }
    }

    return []
  } catch (error) {
    console.error('Error in getTraderMonthlyPerformance:', error)
    return []
  }
}

/**
 * 获取交易员年度表现
 */
export async function getTraderYearlyPerformance(handle: string): Promise<Array<{ year: number; value: number }>> {
  try {
    const decodedHandle = decodeURIComponent(handle)
    const sources = ['binance_web3', 'binance', 'bybit', 'bitget', 'mexc', 'coinex', 'okx', 'kucoin', 'gate']
    
    for (const sourceType of sources) {
      let source = null
      const { data: source1 } = await supabase
        .from('trader_sources')
        .select('source_trader_id')
        .eq('source', sourceType)
        .eq('handle', handle)
        .maybeSingle()
      
      if (source1) {
        source = source1
      } else if (decodedHandle !== handle) {
        const { data: source2 } = await supabase
          .from('trader_sources')
          .select('source_trader_id')
          .eq('source', sourceType)
          .eq('handle', decodedHandle)
          .maybeSingle()
        if (source2) source = source2
      }
      
      if (!source) {
        const { data: source3 } = await supabase
          .from('trader_sources')
          .select('source_trader_id')
          .eq('source', sourceType)
          .eq('source_trader_id', handle)
          .maybeSingle()
        if (source3) source = source3
      }
      
      if (!source) continue

      // 获取年度表现
      const { data: yearlyData } = await supabase
        .from('trader_yearly_performance')
        .select('year, roi')
        .eq('source', sourceType)
        .eq('source_trader_id', source.source_trader_id)
        .order('year', { ascending: false })
        .limit(5)

      if (yearlyData && yearlyData.length > 0) {
        return yearlyData.map((item: any) => ({
          year: item.year,
          value: item.roi ?? 0,
        }))
      }
    }

    return []
  } catch (error) {
    console.error('Error in getTraderYearlyPerformance:', error)
    return []
  }
}

/**
 * 获取交易员投资组合
 */
export async function getTraderPortfolio(handle: string): Promise<PortfolioItem[]> {
  try {
    // 解码 URL 编码的 handle
    const decodedHandle = decodeURIComponent(handle)
    
    // 尝试所有数据源：binance_web3, binance, bybit, bitget, mexc, coinex, okx, kucoin, gate
    const sources = ['binance_web3', 'binance', 'bybit', 'bitget', 'mexc', 'coinex', 'okx', 'kucoin', 'gate']
    
    for (const sourceType of sources) {
      // 先获取 source_trader_id - 尝试多个可能的 handle 值
      let source = null
      const { data: source1 } = await supabase
        .from('trader_sources')
        .select('source_trader_id')
        .eq('source', sourceType)
        .eq('handle', handle)
        .maybeSingle()
      
      if (source1) {
        source = source1
      } else if (decodedHandle !== handle) {
        const { data: source2 } = await supabase
          .from('trader_sources')
          .select('source_trader_id')
          .eq('source', sourceType)
          .eq('handle', decodedHandle)
          .maybeSingle()
        if (source2) source = source2
      }
      
      // 如果 handle 找不到，尝试作为 source_trader_id
      if (!source) {
        const { data: source3 } = await supabase
          .from('trader_sources')
          .select('source_trader_id')
          .eq('source', sourceType)
          .eq('source_trader_id', handle)
          .maybeSingle()
        if (source3) source = source3
      }
      
      if (!source && decodedHandle !== handle) {
        const { data: source4 } = await supabase
          .from('trader_sources')
          .select('source_trader_id')
          .eq('source', sourceType)
          .eq('source_trader_id', decodedHandle)
          .maybeSingle()
        if (source4) source = source4
      }

      if (!source) {
        continue
      }

      // 获取最新的持仓数据
      const { data: portfolioData } = await supabase
        .from('trader_portfolio')
        .select('symbol, direction, weight_pct, entry_price, pnl_pct')
        .eq('source', sourceType)
        .eq('source_trader_id', source.source_trader_id)
        .order('updated_at', { ascending: false })
        .limit(100)

      if (portfolioData && portfolioData.length > 0) {
        return portfolioData.map((item: any) => ({
          market: item.symbol || '',
          direction: (item.direction === 'long' || item.direction === 'short') ? item.direction : 'long',
          invested: item.weight_pct ?? 0,
          pnl: item.pnl_pct ?? 0,
          value: item.weight_pct ?? 0,
          price: item.entry_price ?? 0,
          priceChange: undefined,
        }))
      }
    }

    // 如果没有找到，返回空数组
    return []
  } catch (error) {
    console.error('Error in getTraderPortfolio:', error)
    return []
  }
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

/**
 * 获取交易员历史订单
 */
export async function getTraderPositionHistory(handle: string): Promise<PositionHistoryItem[]> {
  try {
    const decodedHandle = decodeURIComponent(handle)
    const sources = ['binance', 'bybit', 'bitget', 'okx', 'kucoin', 'gate', 'mexc', 'coinex']
    
    for (const sourceType of sources) {
      // 获取 source_trader_id
      const { data: source } = await supabase
        .from('trader_sources')
        .select('source_trader_id')
        .eq('source', sourceType)
        .or(`handle.eq.${handle},handle.eq.${decodedHandle},source_trader_id.eq.${handle}`)
        .limit(1)
        .maybeSingle()

      if (!source) continue

      // 获取历史订单
      const { data: history } = await supabase
        .from('trader_position_history')
        .select('symbol, direction, entry_price, exit_price, pnl_pct, open_time, close_time')
        .eq('source', sourceType)
        .eq('source_trader_id', source.source_trader_id)
        .order('close_time', { ascending: false })
        .limit(50)

      if (history && history.length > 0) {
        return history.map((item: any) => ({
          symbol: item.symbol || '',
          direction: item.direction === 'short' ? 'short' : 'long',
          entryPrice: item.entry_price || 0,
          exitPrice: item.exit_price || 0,
          pnlPct: item.pnl_pct || 0,
          openTime: item.open_time || '',
          closeTime: item.close_time || '',
        }))
      }
    }

    return []
  } catch (error) {
    console.error('Error in getTraderPositionHistory:', error)
    return []
  }
}

/**
 * 获取交易员动态 feed（包括自己发布的帖子和转发的帖子）
 */
export async function getTraderFeed(handle: string): Promise<TraderFeedItem[]> {
  try {
    // 解码 URL 编码的 handle
    const decodedHandle = decodeURIComponent(handle)
    
    // 从 posts 表获取交易员发布的帖子 - 尝试多个可能的 handle 值
    let posts: any[] = []
    const { data: posts1 } = await supabase
      .from('posts')
      .select('id, title, content, created_at, group_id, like_count, is_pinned, groups(name)')
      .eq('author_handle', handle)
      .order('created_at', { ascending: false })
      .limit(20)
    
    if (posts1 && posts1.length > 0) {
      posts = posts1
    } else if (decodedHandle !== handle) {
      const { data: posts2 } = await supabase
        .from('posts')
        .select('id, title, content, created_at, group_id, like_count, is_pinned, groups(name)')
        .eq('author_handle', decodedHandle)
        .order('created_at', { ascending: false })
        .limit(20)
      if (posts2) posts = posts2
    }

    // 获取用户 ID（通过 handle 查找）
    const { data: userProfile } = await supabase
      .from('user_profiles')
      .select('id')
      .eq('handle', decodedHandle)
      .maybeSingle()

    // 获取用户转发的帖子
    let reposts: any[] = []
    if (userProfile?.id) {
      const { data: repostsData } = await supabase
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
      
      if (repostsData) {
        reposts = repostsData
      }
    }

    // 合并自己发的帖子
    const feedItems: TraderFeedItem[] = posts.map((post: any) => ({
      id: post.id,
      type: post.group_id ? 'group_post' : 'post',
      title: post.title,
      content: post.content || '',
      time: post.created_at,
      groupId: post.group_id,
      groupName: post.groups?.name,
      like_count: post.like_count || 0,
      is_pinned: post.is_pinned || false,
    }))

    // 添加转发的帖子
    reposts.forEach((repost: any) => {
      if (repost.posts) {
        feedItems.push({
          id: `repost-${repost.id}`,
          type: 'repost',
          title: repost.posts.title,
          content: repost.posts.content || '',
          time: repost.created_at,
          groupId: repost.posts.group_id,
          groupName: repost.posts.groups?.name,
          like_count: repost.posts.like_count || 0,
          is_pinned: false,
          repost_comment: repost.comment,
          original_author_handle: repost.posts.author_handle,
          original_post_id: repost.posts.id,
        })
      }
    })

    // 按时间排序（最新的在前）
    feedItems.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime())

    return feedItems
  } catch (error) {
    console.error('Error fetching trader feed:', error)
    return []
  }
}

/**
 * 获取相似交易员
 * 基于 ROI 范围匹配真正相似的交易员（ROI ±30% 范围内）
 * 如果当前交易员没有快照数据，则返回同数据源 ROI 最高的交易员
 */
export async function getSimilarTraders(handle: string, limit: number = 6): Promise<TraderProfile[]> {
  try {
    // 解码 URL 编码的 handle
    const decodedHandle = decodeURIComponent(handle)
    
    // 尝试所有数据源：binance_web3, binance, bybit, bitget, mexc, coinex, okx, kucoin, gate
    const sources = ['binance_web3', 'binance', 'bybit', 'bitget', 'mexc', 'coinex', 'okx', 'kucoin', 'gate']
    
    // 辅助函数：获取并返回交易员列表
    const buildTraderProfiles = async (
      snapshots: Array<{ source_trader_id: string; roi: number | null }>,
      sourceType: string,
      excludeId?: string
    ): Promise<TraderProfile[]> => {
      const filteredSnapshots = excludeId 
        ? snapshots.filter(s => s.source_trader_id !== excludeId)
        : snapshots
      
      if (filteredSnapshots.length === 0) return []
      
      const traderIds = filteredSnapshots.slice(0, limit).map(s => s.source_trader_id)
      const { data: sourcesData } = await supabase
        .from('trader_sources')
        .select('source_trader_id, handle, profile_url')
        .eq('source', sourceType)
        .in('source_trader_id', traderIds)

      const handleMap = new Map()
      if (sourcesData) {
        sourcesData.forEach((s: any) => {
          handleMap.set(s.source_trader_id, { 
            handle: s.handle || s.source_trader_id, 
            profile_url: s.profile_url,
          })
        })
      }

      const { getTradersArenaFollowersCount } = await import('./trader-followers')
      const arenaFollowersMap = await getTradersArenaFollowersCount(supabase, traderIds)

      return filteredSnapshots.slice(0, limit).map(s => {
        const sourceInfo = handleMap.get(s.source_trader_id) || { handle: s.source_trader_id, profile_url: null }
        const arenaFollowersCount = arenaFollowersMap.get(s.source_trader_id) || 0
        return {
          handle: sourceInfo.handle,
          id: s.source_trader_id,
          followers: arenaFollowersCount,
          avatar_url: sourceInfo.profile_url || undefined,
          source: sourceType,
        }
      })
    }
    
    for (const sourceType of sources) {
      // 获取最新快照时间
      const { data: latestSnapshot } = await supabase
        .from('trader_snapshots')
        .select('captured_at')
        .eq('source', sourceType)
        .order('captured_at', { ascending: false })
        .limit(1)
        .maybeSingle()

      if (!latestSnapshot) continue
      
      // 获取当前交易员的 source_trader_id
      let currentSource = null
      const { data: currentSource1 } = await supabase
        .from('trader_sources')
        .select('source_trader_id')
        .eq('source', sourceType)
        .eq('handle', handle)
        .maybeSingle()
      
      if (currentSource1) {
        currentSource = currentSource1
      } else if (decodedHandle !== handle) {
        const { data: currentSource2 } = await supabase
          .from('trader_sources')
          .select('source_trader_id')
          .eq('source', sourceType)
          .eq('handle', decodedHandle)
          .maybeSingle()
        if (currentSource2) currentSource = currentSource2
      }
      
      if (!currentSource) {
        const { data: currentSource3 } = await supabase
          .from('trader_sources')
          .select('source_trader_id')
          .eq('source', sourceType)
          .eq('source_trader_id', handle)
          .maybeSingle()
        if (currentSource3) currentSource = currentSource3
      }
      
      if (!currentSource && decodedHandle !== handle) {
        const { data: currentSource4 } = await supabase
          .from('trader_sources')
          .select('source_trader_id')
          .eq('source', sourceType)
          .eq('source_trader_id', decodedHandle)
          .maybeSingle()
        if (currentSource4) currentSource = currentSource4
      }

      // 如果找不到当前交易员，尝试下一个数据源
      if (!currentSource) continue

      // 获取当前交易员的 ROI（可能没有最新快照数据）
      const { data: currentTraderSnapshot } = await supabase
        .from('trader_snapshots')
        .select('roi')
        .eq('source', sourceType)
        .eq('source_trader_id', currentSource.source_trader_id)
        .order('captured_at', { ascending: false })
        .limit(1)
        .maybeSingle()

      const currentRoi = currentTraderSnapshot?.roi ?? 0
      
      // 计算 ROI 范围（±30%，最小范围 ±20）
      const roiRange = Math.max(Math.abs(currentRoi) * 0.3, 20)
      const minRoi = currentRoi - roiRange
      const maxRoi = currentRoi + roiRange

      // 获取 ROI 相似范围内的交易员
      const { data: snapshots } = await supabase
        .from('trader_snapshots')
        .select('source_trader_id, roi')
        .eq('source', sourceType)
        .eq('captured_at', latestSnapshot.captured_at)
        .neq('source_trader_id', currentSource.source_trader_id)
        .gte('roi', minRoi)
        .lte('roi', maxRoi)
        .limit(50)

      if (snapshots && snapshots.length > 0) {
        // 按 ROI 差距排序，选择最相似的
        const sortedByDiff = snapshots
          .map(s => ({ ...s, diff: Math.abs((s.roi || 0) - currentRoi) }))
          .sort((a, b) => a.diff - b.diff)
        
        const result = await buildTraderProfiles(sortedByDiff, sourceType)
        if (result.length > 0) return result
      }

      // 降级：获取 ROI 最高的交易员（排除当前交易员）
      const { data: fallbackSnapshots } = await supabase
        .from('trader_snapshots')
        .select('source_trader_id, roi')
        .eq('source', sourceType)
        .eq('captured_at', latestSnapshot.captured_at)
        .neq('source_trader_id', currentSource.source_trader_id)
        .order('roi', { ascending: false })
        .limit(limit)
      
      if (fallbackSnapshots && fallbackSnapshots.length > 0) {
        const result = await buildTraderProfiles(fallbackSnapshots, sourceType)
        if (result.length > 0) return result
      }
    }

    return []
  } catch (error) {
    console.error('Error fetching similar traders:', error)
    return []
  }
}

