/**
 * Trader Data Adapter
 * 数据适配层 - 从 Supabase 获取交易员数据，缺失字段使用 mock
 */

import { supabase } from '@/lib/supabase/client'

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
  type: 'post' | 'group_post'
  title: string
  content?: string
  time: string
  groupId?: string
  groupName?: string
  like_count?: number
  is_pinned?: boolean
}

/**
 * 根据 handle 获取交易员基本信息
 */
export async function getTraderByHandle(handle: string): Promise<TraderProfile | null> {
  if (!handle) return null

  try {
    // 解码 URL 编码的 handle
    const decodedHandle = decodeURIComponent(handle)
    
    // 尝试所有数据源：binance_web3, binance, bybit, bitget, mexc, coinex, okx, kucoin, gate
    const sources = ['binance_web3', 'binance', 'bybit', 'bitget', 'mexc', 'coinex', 'okx', 'kucoin', 'gate']
    
    for (const sourceType of sources) {
      // 从 trader_sources 表获取交易员信息（只查询 profile_url，因为 avatar_url 列不存在）
      // 先尝试原始 handle
      let source = null
      let sourceError = null
      
      // 尝试用原始 handle 查询（只查询 profile_url）
      const { data: source1, error: error1 } = await supabase
        .from('trader_sources')
        .select('source_trader_id, handle, profile_url')
        .eq('source', sourceType)
        .eq('handle', handle)
        .maybeSingle()
      
      if (source1) {
        source = source1
      } else if (error1) {
        // 检查是否有实际的错误内容
        // 空对象 {} 的 error1.message 是 undefined，所以 hasErrorContent 是 false
        // 只有当错误对象有实际有值的属性（message/code/hint/details）时，才认为是真正的错误
        const hasErrorContent = !!(error1.message || error1.code || error1.hint || error1.details)
        // 如果错误对象有实际错误内容，才设置 sourceError
        // 注意：即使是 {message: undefined} 这种，hasErrorContent 也会是 false，因为 !!undefined 是 false
        if (hasErrorContent) {
          sourceError = error1
        }
        // 如果 hasErrorContent 是 false（空对象 {} 或所有属性都是 undefined），则不设置 sourceError
        // 这是正常的"没找到记录"情况，不应该记录为错误
      }
      
      // 如果原始 handle 找不到，尝试解码后的 handle（如果不同）
      if (!source && decodedHandle !== handle) {
        const { data: source2, error: error2 } = await supabase
          .from('trader_sources')
          .select('source_trader_id, handle, profile_url')
          .eq('source', sourceType)
          .eq('handle', decodedHandle)
          .maybeSingle()
        
        if (source2) {
          source = source2
        } else if (error2 && !sourceError) {
          // 检查是否有实际的错误内容
          // 空对象 {} 的 Object.keys({}) 返回 []，但更重要的是检查属性值
          // 只有当错误对象有实际有值的属性（message/code/hint/details）时，才认为是真正的错误
          const hasErrorContent = !!(error2.message || error2.code || error2.hint || error2.details)
          // 如果错误对象有实际错误内容，才设置 sourceError
          // 注意：即使是 {message: undefined} 这种，hasErrorContent 也会是 false，因为 !!undefined 是 false
          if (hasErrorContent) {
            sourceError = error2
          }
          // 如果 hasErrorContent 是 false（空对象 {} 或所有属性都是 undefined），则不设置 sourceError
          // 这是正常的"没找到记录"情况，不应该记录为错误
        }
      }

      // 只在有实际错误内容时记录和跳过（查询失败且有明确的错误信息）
      // 注意：sourceError 只在之前检测到有实际错误内容时才会被设置
      // 如果 sourceError 存在，说明确实有错误，应该记录并跳过
      // 但是为了安全起见，我们再次确认错误对象确实有错误内容
      if (sourceError) {
        // 再次确认：只有当错误对象有实际的错误信息时，才记录错误
        const hasErrorContent = !!(sourceError.message || sourceError.code || sourceError.hint || sourceError.details)
        if (hasErrorContent) {
          // 确认是真正的错误，记录并跳过
          console.error(`Error fetching trader_source by handle (${sourceType}):`, sourceError)
          continue
        } else {
          // 如果没有实际错误内容（空对象{}或所有属性都是undefined），清除 sourceError 继续处理
          // 这是正常的"没找到记录"情况，不应该记录为错误
          // 这种情况理论上不应该发生，因为我们在设置 sourceError 时已经检查过了
          sourceError = null
        }
      }

      if (!source) {
        // 如果 handle 匹配不到，尝试用 handle 或 decodedHandle 作为 source_trader_id 查询
        const { data: sourceById1 } = await supabase
          .from('trader_sources')
          .select('source_trader_id, handle, profile_url')
          .eq('source', sourceType)
          .eq('source_trader_id', handle)
          .maybeSingle()
        
        if (sourceById1) {
          source = sourceById1
        } else if (decodedHandle !== handle) {
          const { data: sourceById2 } = await supabase
            .from('trader_sources')
            .select('source_trader_id, handle, profile_url')
            .eq('source', sourceType)
            .eq('source_trader_id', decodedHandle)
            .maybeSingle()
          
          if (sourceById2) {
            source = sourceById2
          }
        }
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
      const traderAvatarUrl = source.profile_url || null
      return {
        handle: source.handle || source.source_trader_id,
        id: source.source_trader_id,
        bio: profile?.bio || null,
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

      // 获取最新的 ROI 数据（包括多时间段）
      const { data: latestSnapshot } = await supabase
        .from('trader_snapshots')
        .select('roi, roi_7d, roi_30d, roi_1y, roi_2y')
        .eq('source', sourceType)
        .eq('source_trader_id', source.source_trader_id)
        .order('captured_at', { ascending: false })
        .limit(1)
        .maybeSingle()

      // 返回真实数据（包括多时间段ROI）
      return {
        roi_7d: latestSnapshot?.roi_7d ?? undefined,
        roi_30d: latestSnapshot?.roi_30d ?? undefined,
        roi_90d: latestSnapshot?.roi || 0,
        roi_1y: latestSnapshot?.roi_1y ?? undefined,
        roi_2y: latestSnapshot?.roi_2y ?? undefined,
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

      // 获取最新的快照数据（包含新字段）
      const { data: latestSnapshot } = await supabase
        .from('trader_snapshots')
        .select('roi, captured_at, total_trades, avg_profit, avg_loss, profitable_trades_pct, risk_score, avg_holding_time_days, trades_per_week, volume_90d, max_drawdown, sharpe_ratio')
        .eq('source', sourceType)
        .eq('source_trader_id', source.source_trader_id)
        .order('captured_at', { ascending: false })
        .limit(1)
        .maybeSingle()

      // 获取历史快照数据用于计算
      const { data: snapshots } = await supabase
        .from('trader_snapshots')
        .select('roi, captured_at')
        .eq('source', sourceType)
        .eq('source_trader_id', source.source_trader_id)
        .order('captured_at', { ascending: true })

      if (!snapshots || snapshots.length === 0) {
        continue
      }

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
      return {
        // account_required_* 字段需要绑定账户，返回undefined
        expectedDividends: undefined,
        trading: latestSnapshot ? {
          totalTrades12M: latestSnapshot.total_trades ?? 0,
          avgProfit: latestSnapshot.avg_profit ?? 0,
          avgLoss: latestSnapshot.avg_loss ?? 0,
          profitableTradesPct: latestSnapshot.profitable_trades_pct ?? 0,
        } : undefined,
        frequentlyTraded: frequentlyTraded.length > 0 ? frequentlyTraded : undefined,
        // derived_from_snapshot_* 字段
        additionalStats: {
          tradesPerWeek: latestSnapshot?.trades_per_week ?? undefined,
          avgHoldingTime: latestSnapshot?.avg_holding_time_days ? `${latestSnapshot.avg_holding_time_days}天` : undefined,
          activeSince, // 可以从最早快照计算
          profitableWeeksPct, // 可以从历史快照计算
          riskScore: latestSnapshot?.risk_score ?? undefined,
          volume90d: latestSnapshot?.volume_90d ?? undefined,
          maxDrawdown: latestSnapshot?.max_drawdown ?? undefined,
          sharpeRatio: latestSnapshot?.sharpe_ratio ?? undefined,
        },
        monthlyPerformance: monthlyPerformance.length > 0 ? monthlyPerformance : undefined,
        yearlyPerformance: yearlyPerformance.length > 0 ? yearlyPerformance : undefined,
      }
    }

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
 * 注意：Portfolio数据需要绑定账户才能获取，目前返回空数组
 */
export async function getTraderPortfolio(handle: string): Promise<PortfolioItem[]> {
  // Portfolio数据需要用户授权访问私有交易数据，目前无法获取
  // 返回空数组，UI会显示空状态提示
  void handle
  return []
}

/**
 * 获取交易员动态 feed
 */
export async function getTraderFeed(handle: string): Promise<TraderFeedItem[]> {
  try {
    // 解码 URL 编码的 handle
    const decodedHandle = decodeURIComponent(handle)
    
    // 从 posts 表获取交易员发布的帖子 - 尝试多个可能的 handle 值
    let posts = null
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

    if (!posts) return []

    return posts.map((post: any) => ({
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
  } catch (error) {
    console.error('Error fetching trader feed:', error)
    return []
  }
}

/**
 * 获取相似交易员
 */
export async function getSimilarTraders(handle: string, limit: number = 6): Promise<TraderProfile[]> {
  try {
    // 尝试所有数据源：binance_web3, binance, bybit, bitget, mexc, coinex, okx, kucoin, gate
    const sources = ['binance_web3', 'binance', 'bybit', 'bitget', 'mexc', 'coinex', 'okx', 'kucoin', 'gate']
    
    for (const sourceType of sources) {
      // 从 trader_sources 和 trader_snapshots 获取相似交易员（按 ROI 排名）
      const { data: latestSnapshot } = await supabase
        .from('trader_snapshots')
        .select('captured_at')
        .eq('source', sourceType)
        .order('captured_at', { ascending: false })
        .limit(1)
        .maybeSingle()

      if (!latestSnapshot) continue

      // 解码 URL 编码的 handle
      const decodedHandle = decodeURIComponent(handle)
      
      // 获取当前交易员的 source_trader_id - 尝试多个可能的 handle 值
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
      
      // 如果 handle 找不到，尝试作为 source_trader_id
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

      // 获取最新的排名数据，排除当前交易员
      const { data: snapshots } = await supabase
        .from('trader_snapshots')
        .select('source_trader_id, roi')
        .eq('source', sourceType)
        .eq('captured_at', latestSnapshot.captured_at)
        .neq('source_trader_id', currentSource?.source_trader_id || '')
        .order('roi', { ascending: false })
        .limit(limit)

      if (!snapshots || snapshots.length === 0) continue

      // 获取对应的 handles（只查询 profile_url，因为 avatar_url 列不存在）
      const traderIds = snapshots.map((s: any) => s.source_trader_id)
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
            // 注意：avatar_url 列不存在，所以只使用 profile_url
          })
        })
      }

      // 批量获取 Arena 粉丝数（从 trader_follows 表统计）
      const { getTradersArenaFollowersCount } = await import('./trader-followers')
      const arenaFollowersMap = await getTradersArenaFollowersCount(supabase, traderIds)

      return snapshots.map((s: any) => {
        const sourceInfo = handleMap.get(s.source_trader_id) || { handle: s.source_trader_id, profile_url: null }
        const arenaFollowersCount = arenaFollowersMap.get(s.source_trader_id) || 0
        return {
          handle: sourceInfo.handle,
          id: s.source_trader_id,
          followers: arenaFollowersCount, // 使用 Arena 粉丝数（从 trader_follows 表统计）
          avatar_url: sourceInfo.profile_url || null,
          source: sourceType,
        }
      })
    }

    return []
  } catch (error) {
    console.error('Error fetching similar traders:', error)
    return []
  }
}

