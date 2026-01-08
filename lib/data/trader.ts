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
  roi_7d?: number
  roi_30d?: number
  roi_90d?: number
  roi_1y?: number
  roi_2y?: number
  return_ytd?: number
  return_2y?: number
  risk_score_last_7d?: number
  profitable_weeks?: number
  monthlyPerformance?: Array<{ month: string; value: number }>
  yearlyPerformance?: Array<{ year: number; value: number }>
}

export interface TraderStats {
  expectedDividends?: {
    dividendYield: number
    assets: number
    trendingStocks: Array<{
      symbol: string
      yield: number
      icon?: string
    }>
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
    tradesPerWeek: number
    avgHoldingTime: string
    activeSince: string
    profitableWeeksPct: number
  }
  monthlyPerformance?: Array<{ month: string; value: number }>
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
    
    // 尝试所有数据源：binance_web3, binance, bybit, bitget, mexc, coinex
    const sources = ['binance_web3', 'binance', 'bybit', 'bitget', 'mexc', 'coinex']
    
    for (const sourceType of sources) {
      // 从 trader_sources 表获取交易员信息
      // 先尝试原始 handle
      let source = null
      let sourceError = null
      
      // 尝试用原始 handle 查询
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
        const hasErrorContent = error1.message || error1.code || error1.hint || error1.details
        if (hasErrorContent) {
          sourceError = error1
        }
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
          const hasErrorContent = error2.message || error2.code || error2.hint || error2.details
          if (hasErrorContent) {
            sourceError = error2
          }
        }
      }

      // 只在有实际错误内容时记录和跳过
      if (sourceError) {
        const hasErrorContent = sourceError.message || sourceError.code || sourceError.hint || sourceError.details
        if (hasErrorContent) {
          console.error(`Error fetching trader_source by handle (${sourceType}):`, sourceError)
          continue
        }
        // 如果没有实际错误内容，清除 sourceError 继续处理
        sourceError = null
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

      // 获取最新的 followers 数据
      const { data: latestSnapshot } = await supabase
        .from('trader_snapshots')
        .select('followers')
        .eq('source', sourceType)
        .eq('source_trader_id', source.source_trader_id)
        .order('captured_at', { ascending: false })
        .limit(1)
        .maybeSingle()

      // 检查是否在平台注册（从 profiles 表）
      const profileHandle = source.handle || source.source_trader_id
      // 尝试多个可能的 handle 值
      const { data: profile1 } = await supabase
        .from('profiles')
        .select('id, bio, avatar_url')
        .eq('handle', profileHandle)
        .maybeSingle()
      
      let profile = profile1
      if (!profile && decodedHandle !== handle) {
        const { data: profile2 } = await supabase
          .from('profiles')
          .select('id, bio, avatar_url')
          .eq('handle', decodedHandle)
          .maybeSingle()
        if (profile2) profile = profile2
      }
      if (!profile && handle !== profileHandle) {
        const { data: profile3 } = await supabase
          .from('profiles')
          .select('id, bio, avatar_url')
          .eq('handle', handle)
          .maybeSingle()
        if (profile3) profile = profile3
      }

      console.log(`[trader] Found trader: ${source.handle || source.source_trader_id} (source: ${sourceType})`)
      return {
        handle: source.handle || source.source_trader_id,
        id: source.source_trader_id,
        bio: profile?.bio || null,
        followers: latestSnapshot?.followers || 0,
        copiers: 0,
        avatar_url: profile?.avatar_url || source.profile_url || null,
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
    
    // 尝试所有数据源：binance_web3, binance, bybit, bitget, mexc, coinex
    const sources = ['binance_web3', 'binance', 'bybit', 'bitget', 'mexc', 'coinex']
    
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

      // 获取最新的 ROI 数据（90天）
      const { data: latestSnapshot } = await supabase
        .from('trader_snapshots')
        .select('roi')
        .eq('source', sourceType)
        .eq('source_trader_id', source.source_trader_id)
        .order('captured_at', { ascending: false })
        .limit(1)
        .maybeSingle()

      // 返回真实数据（目前只有 90D ROI，其他字段暂时使用默认值）
      return {
        roi_90d: latestSnapshot?.roi || 0,
        return_ytd: latestSnapshot?.roi || 0,
        // 其他字段暂时保持为空，等有真实数据源后再补充
      }
    }

    // 如果没有找到，返回默认值
    return {
      roi_90d: 0,
      return_ytd: 0,
    }
  } catch (error) {
    console.error('Error in getTraderPerformance:', error)
    return {
      roi_90d: 0,
      return_ytd: 0,
    }
  }
}

/**
 * 获取交易员统计数据
 */
export async function getTraderStats(handle: string): Promise<TraderStats> {
  // TODO: 从真实数据表获取
  void handle
  return {
    expectedDividends: {
      dividendYield: 0.05,
      assets: 8,
      trendingStocks: [
        { symbol: 'NTES', yield: 2.15 },
        { symbol: 'TGT', yield: 4.64 },
        { symbol: 'AAPL', yield: 0.52 },
      ],
    },
    trading: {
      totalTrades12M: 357,
      avgProfit: 400.65,
      avgLoss: -63.82,
      profitableTradesPct: 48.46,
    },
    frequentlyTraded: [
      {
        symbol: 'ARVLF',
        weightPct: 11.24,
        count: 40,
        avgProfit: 0,
        avgLoss: -99.99,
        profitablePct: 0,
      },
      {
        symbol: 'NIO',
        weightPct: 8.68,
        count: 31,
        avgProfit: 29.0,
        avgLoss: -59.02,
        profitablePct: 6.45,
      },
      {
        symbol: 'PLTR',
        weightPct: 7.56,
        count: 27,
        avgProfit: 1688.25,
        avgLoss: 0,
        profitablePct: 100.0,
      },
    ],
    additionalStats: {
      tradesPerWeek: 6.26,
      avgHoldingTime: '31.5 Months',
      activeSince: '2/8/22',
      profitableWeeksPct: 54.39,
    },
    monthlyPerformance: [
      { month: 'Jan', value: 5.57 },
      { month: 'Feb', value: -23.53 },
      { month: 'Mar', value: -7.51 },
      { month: 'Apr', value: 9.65 },
      { month: 'May', value: 17.86 },
      { month: 'Jun', value: 1.13 },
      { month: 'Jul', value: 20.97 },
      { month: 'Aug', value: 3.11 },
      { month: 'Sep', value: 0.42 },
      { month: 'Oct', value: -5.62 },
      { month: 'Nov', value: -19.30 },
      { month: 'Dec', value: -1.77 },
    ],
  }
}

/**
 * 获取交易员投资组合
 */
export async function getTraderPortfolio(handle: string): Promise<PortfolioItem[]> {
  // TODO: 从真实数据表获取
  void handle
  return [
    {
      market: 'NIO',
      direction: 'long',
      invested: 13.45,
      pnl: -53.11,
      value: 2.03,
      price: 5.1,
      priceChange: -0.4,
      priceChangePct: -7.27,
    },
    {
      market: 'NVDA',
      direction: 'long',
      invested: 10.07,
      pnl: 69.21,
      value: 5.48,
      price: 186.5,
      priceChange: -1.04,
      priceChangePct: -0.55,
    },
    {
      market: 'PLTR',
      direction: 'long',
      invested: 9.58,
      pnl: 1663.81,
      value: 54.29,
      price: 177.75,
      priceChange: -3.09,
      priceChangePct: -1.71,
    },
    {
      market: 'CHPT',
      direction: 'long',
      invested: 8.57,
      pnl: -90.4,
      value: 0.26,
      price: 6.64,
      priceChange: -0.09,
      priceChangePct: -1.34,
    },
    {
      market: 'TSLA',
      direction: 'long',
      invested: 8.23,
      pnl: 126.19,
      value: 5.98,
      price: 449.72,
      priceChange: -4.71,
      priceChangePct: -1.04,
    },
  ]
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
    // 尝试所有数据源：binance_web3, binance, bybit, bitget, mexc, coinex
    const sources = ['binance_web3', 'binance', 'bybit', 'bitget', 'mexc', 'coinex']
    
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
        .select('source_trader_id, roi, followers')
        .eq('source', sourceType)
        .eq('captured_at', latestSnapshot.captured_at)
        .neq('source_trader_id', currentSource?.source_trader_id || '')
        .order('roi', { ascending: false })
        .limit(limit)

      if (!snapshots || snapshots.length === 0) continue

      // 获取对应的 handles
      const traderIds = snapshots.map((s: any) => s.source_trader_id)
      const { data: sourcesData } = await supabase
        .from('trader_sources')
        .select('source_trader_id, handle, profile_url')
        .eq('source', sourceType)
        .in('source_trader_id', traderIds)

      const handleMap = new Map()
      if (sourcesData) {
        sourcesData.forEach((s: any) => {
          handleMap.set(s.source_trader_id, { handle: s.handle || s.source_trader_id, profile_url: s.profile_url })
        })
      }

      return snapshots.map((s: any) => {
        const sourceInfo = handleMap.get(s.source_trader_id) || { handle: s.source_trader_id, profile_url: null }
        return {
          handle: sourceInfo.handle,
          id: s.source_trader_id,
          followers: s.followers || 0,
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

