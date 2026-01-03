/**
 * Trader Data Adapter
 * 数据适配层 - 从 Supabase 获取交易员数据，缺失字段使用 mock
 */

import { supabase } from '@/lib/supabase/client'

export interface TraderProfile {
  handle: string
  id: string
  bio?: string
  followers?: number
  copiers?: number
  avatar_url?: string
  isRegistered?: boolean // 是否在平台注册
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
}

/**
 * 根据 handle 获取交易员基本信息
 */
export async function getTraderByHandle(handle: string): Promise<TraderProfile | null> {
  if (!handle) return null

  try {
    // 先尝试从 traders 表获取
    const { data: trader, error } = await supabase
      .from('traders')
      .select('id, handle, roi, win_rate, followers')
      .eq('handle', handle)
      .maybeSingle()

    if (error) {
      console.error('Error fetching trader by handle:', error)
      return null
    }

    if (!trader) {
      // 如果 traders 表中没有，尝试用 handle 作为 id 查询（向后兼容）
      const { data: traderById, error: idError } = await supabase
        .from('traders')
        .select('id, handle, roi, win_rate, followers')
        .eq('id', handle)
        .maybeSingle()
      
      if (idError) {
        console.error('Error fetching trader by id:', idError)
        return null
      }

      if (!traderById) {
        return null
      }
      
      // 使用找到的 trader
      const foundTrader = traderById
      const traderHandle = foundTrader.handle || foundTrader.id
      
      // 检查是否在平台注册（从 profiles 表）
      const { data: profile } = await supabase
        .from('profiles')
        .select('id, bio, avatar_url')
        .eq('handle', traderHandle)
        .maybeSingle()

      return {
        handle: traderHandle,
        id: foundTrader.id,
        bio: profile?.bio || `交易员 ${traderHandle} 的个人简介`,
        followers: foundTrader.followers || 0,
        copiers: 0,
        avatar_url: profile?.avatar_url,
        isRegistered: !!profile,
      }
    }

    // 检查是否在平台注册（从 profiles 表）
    const { data: profile } = await supabase
      .from('profiles')
      .select('id, bio, avatar_url')
      .eq('handle', handle)
      .maybeSingle()

    return {
      handle: trader.handle,
      id: trader.id,
      bio: profile?.bio || `交易员 ${handle} 的个人简介`,
      followers: trader.followers || 0,
      copiers: 0, // TODO: 从 copiers 表获取
      avatar_url: profile?.avatar_url,
      isRegistered: !!profile,
    }
  } catch (error) {
    console.error('Error in getTraderByHandle:', error)
    return null
  }
}

/**
 * 获取交易员绩效数据
 */
export async function getTraderPerformance(handle: string, period: '7D' | '30D' | '90D' | '1Y' | '2Y' | 'All' = '90D'): Promise<TraderPerformance> {
  // TODO: 从真实数据表获取
  // 目前使用 mock 数据
  return {
    roi_7d: 2.5,
    roi_30d: 8.3,
    roi_90d: 15.7,
    roi_1y: 45.2,
    roi_2y: 120.5,
    return_ytd: 12.3,
    return_2y: 187.87,
    risk_score_last_7d: 6,
    profitable_weeks: 45.61,
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
    yearlyPerformance: [
      { year: 2019, value: 15.2 },
      { year: 2020, value: 85.3 },
      { year: 2021, value: 42.1 },
      { year: 2022, value: -18.5 },
      { year: 2023, value: 81.76 },
      { year: 2024, value: 73.21 },
      { year: 2025, value: -8.56 },
    ],
  }
}

/**
 * 获取交易员统计数据
 */
export async function getTraderStats(handle: string): Promise<TraderStats> {
  // TODO: 从真实数据表获取
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
    // 从 posts 表获取交易员发布的帖子
    const { data: posts } = await supabase
      .from('posts')
      .select('id, title, content, created_at, group_id, groups(name)')
      .eq('author_handle', handle)
      .order('created_at', { ascending: false })
      .limit(10)

    if (!posts) return []

    return posts.map((post: any) => ({
      id: post.id,
      type: post.group_id ? 'group_post' : 'post',
      title: post.title,
      content: post.content || '',
      time: post.created_at,
      groupId: post.group_id,
      groupName: post.groups?.name,
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
    // TODO: 根据算法获取相似交易员
    // 目前随机返回一些交易员
    const { data: traders } = await supabase
      .from('traders')
      .select('id, handle, followers')
      .neq('handle', handle)
      .order('followers', { ascending: false })
      .limit(limit)

    if (!traders) return []

    return traders.map((t) => ({
      handle: t.handle,
      id: t.id,
      followers: t.followers || 0,
    }))
  } catch (error) {
    console.error('Error fetching similar traders:', error)
    return []
  }
}

