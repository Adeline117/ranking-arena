/**
 * 获取交易员详情 API
 * 
 * 性能优化：
 * - 并行查询所有数据
 * - 内存缓存（5分钟TTL）
 * - 减少数据库往返
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { getServerCache, setServerCache, CacheTTL } from '@/lib/utils/server-cache'

// Next.js 缓存配置
export const revalidate = 300 // 5分钟

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''

// 支持的交易所
const TRADER_SOURCES = ['binance', 'binance_web3', 'bybit', 'bitget', 'okx', 'kucoin', 'gate', 'mexc', 'coinex'] as const
type SourceType = typeof TRADER_SOURCES[number]

// 缓存键前缀
const CACHE_PREFIX = 'trader:'

interface TraderSource {
  source_trader_id: string
  handle: string | null
  profile_url: string | null
}

interface SnapshotData {
  roi: number | null
  pnl: number | null
  win_rate: number | null
  max_drawdown: number | null
  trades_count?: number | null
  followers?: number | null
  captured_at?: string
  season_id?: string
}

// 查找交易员来源
async function findTraderSource(
  supabase: SupabaseClient,
  handle: string
): Promise<{ source: TraderSource; sourceType: SourceType } | null> {
  const decodedHandle = decodeURIComponent(handle)
  
  // 并行查询所有数据源
  const queries = TRADER_SOURCES.map(async (sourceType) => {
    // 先尝试 handle
    const { data: byHandle } = await supabase
      .from('trader_sources')
      .select('source_trader_id, handle, profile_url')
      .eq('source', sourceType)
      .eq('handle', decodedHandle)
      .limit(1)
      .maybeSingle()
    
    if (byHandle) {
      return { source: byHandle as TraderSource, sourceType }
    }
    
    // 再尝试 source_trader_id
    const { data: byId } = await supabase
      .from('trader_sources')
      .select('source_trader_id, handle, profile_url')
      .eq('source', sourceType)
      .eq('source_trader_id', decodedHandle)
      .limit(1)
      .maybeSingle()
    
    if (byId) {
      return { source: byId as TraderSource, sourceType }
    }
    
    return null
  })
  
  const results = await Promise.all(queries)
  return results.find(r => r !== null) || null
}

// 从 trader_snapshots 直接查找交易员（当 trader_sources 没有数据时的回退方案）
async function findTraderFromSnapshots(
  supabase: SupabaseClient,
  handle: string
): Promise<{ traderId: string; sourceType: SourceType } | null> {
  const decodedHandle = decodeURIComponent(handle)
  
  // 并行查询所有数据源的快照
  const queries = TRADER_SOURCES.map(async (sourceType) => {
    const { data } = await supabase
      .from('trader_snapshots')
      .select('source_trader_id')
      .eq('source', sourceType)
      .eq('source_trader_id', decodedHandle)
      .limit(1)
      .maybeSingle()
    
    if (data) {
      return { traderId: data.source_trader_id, sourceType }
    }
    
    return null
  })
  
  const results = await Promise.all(queries)
  return results.find(r => r !== null) || null
}

// 获取交易员详细数据
async function getTraderDetails(
  supabase: SupabaseClient,
  source: TraderSource,
  sourceType: SourceType
) {
  const traderId = source.source_trader_id
  const traderHandle = source.handle || source.source_trader_id
  
  // 🚀 并行获取所有数据
  const [
    snapshotResult,
    snapshot7dResult,
    snapshot30dResult,
    arenaFollowersResult,
    userProfileResult,
    portfolioResult,
    historyResult,
    postsResult,
  ] = await Promise.all([
    // 最新快照
    supabase
      .from('trader_snapshots')
      .select('roi, pnl, win_rate, max_drawdown, trades_count, followers, captured_at, season_id')
      .eq('source', sourceType)
      .eq('source_trader_id', traderId)
      .order('captured_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    
    // 7天快照
    supabase
      .from('trader_snapshots')
      .select('roi, pnl, win_rate, max_drawdown')
      .eq('source', sourceType)
      .eq('source_trader_id', traderId)
      .eq('season_id', '7D')
      .order('captured_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    
    // 30天快照
    supabase
      .from('trader_snapshots')
      .select('roi, pnl, win_rate, max_drawdown')
      .eq('source', sourceType)
      .eq('source_trader_id', traderId)
      .eq('season_id', '30D')
      .order('captured_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    
    // Arena 粉丝数
    supabase
      .from('trader_follows')
      .select('*', { count: 'exact', head: true })
      .eq('trader_id', traderId),
    
    // 用户 profile
    supabase
      .from('user_profiles')
      .select('id, bio')
      .eq('handle', traderHandle)
      .maybeSingle(),
    
    // 持仓数据
    supabase
      .from('trader_portfolio')
      .select('symbol, direction, weight_pct, entry_price, pnl_pct')
      .eq('source', sourceType)
      .eq('source_trader_id', traderId)
      .order('updated_at', { ascending: false })
      .limit(100),
    
    // 历史订单
    supabase
      .from('trader_position_history')
      .select('symbol, direction, entry_price, exit_price, pnl_pct, open_time, close_time')
      .eq('source', sourceType)
      .eq('source_trader_id', traderId)
      .order('close_time', { ascending: false })
      .limit(50),
    
    // 帖子
    supabase
      .from('posts')
      .select('id, title, content, created_at, group_id, like_count, is_pinned, groups(name)')
      .eq('author_handle', traderHandle)
      .order('created_at', { ascending: false })
      .limit(20),
  ])
  
  const snapshot = snapshotResult.data as SnapshotData | null
  const snapshot7d = snapshot7dResult.data as SnapshotData | null
  const snapshot30d = snapshot30dResult.data as SnapshotData | null
  const arenaFollowers = arenaFollowersResult.count || 0
  const userProfile = userProfileResult.data
  const portfolioData = portfolioResult.data || []
  const historyData = historyResult.data || []
  const posts = postsResult.data || []
  
  // 获取相似交易员（单独查询，因为依赖 snapshot 数据）
  let similarTraders: Array<{ handle: string; id: string; followers: number; avatar_url?: string; source: string }> = []
  if (snapshot?.roi !== null && snapshot?.roi !== undefined) {
    const currentRoi = snapshot.roi
    const roiRange = Math.max(Math.abs(currentRoi) * 0.3, 20)
    
    const { data: similarSnapshots } = await supabase
      .from('trader_snapshots')
      .select('source_trader_id, roi')
      .eq('source', sourceType)
      .neq('source_trader_id', traderId)
      .gte('roi', currentRoi - roiRange)
      .lte('roi', currentRoi + roiRange)
      .order('roi', { ascending: false })
      .limit(6)
    
    if (similarSnapshots && similarSnapshots.length > 0) {
      const similarIds = similarSnapshots.map(s => s.source_trader_id)
      const { data: similarSources } = await supabase
        .from('trader_sources')
        .select('source_trader_id, handle, profile_url')
        .eq('source', sourceType)
        .in('source_trader_id', similarIds)
      
      if (similarSources) {
        similarTraders = similarSources.map(s => ({
          handle: s.handle || s.source_trader_id,
          id: s.source_trader_id,
          followers: 0,
          avatar_url: s.profile_url || undefined,
          source: sourceType,
        }))
      }
    }
  }
  
  return {
    profile: {
      handle: traderHandle,
      id: traderId,
      bio: userProfile?.bio || undefined,
      followers: arenaFollowers,
      avatar_url: source.profile_url || undefined,
      isRegistered: !!userProfile,
      source: sourceType,
    },
    performance: {
      roi_90d: snapshot?.roi || 0,
      roi_7d: snapshot7d?.roi ?? undefined,
      roi_30d: snapshot30d?.roi ?? undefined,
      pnl: snapshot?.pnl ?? undefined,
      win_rate: snapshot?.win_rate ?? undefined,
      max_drawdown: snapshot?.max_drawdown ?? undefined,
      pnl_7d: snapshot7d?.pnl ?? undefined,
      pnl_30d: snapshot30d?.pnl ?? undefined,
      win_rate_7d: snapshot7d?.win_rate ?? undefined,
      win_rate_30d: snapshot30d?.win_rate ?? undefined,
      max_drawdown_7d: snapshot7d?.max_drawdown ?? undefined,
      max_drawdown_30d: snapshot30d?.max_drawdown ?? undefined,
    },
    stats: {
      additionalStats: {
        tradesCount: snapshot?.trades_count ?? undefined,
      },
    },
    portfolio: portfolioData.map((item: any) => ({
      market: item.symbol || '',
      direction: item.direction === 'short' ? 'short' : 'long',
      invested: item.weight_pct ?? 0,
      pnl: item.pnl_pct ?? 0,
      value: item.weight_pct ?? 0,
      price: item.entry_price ?? 0,
    })),
    positionHistory: historyData.map((item: any) => ({
      symbol: item.symbol || '',
      direction: item.direction === 'short' ? 'short' : 'long',
      entryPrice: item.entry_price || 0,
      exitPrice: item.exit_price || 0,
      pnlPct: item.pnl_pct || 0,
      openTime: item.open_time || '',
      closeTime: item.close_time || '',
    })),
    feed: posts.map((post: any) => ({
      id: post.id,
      type: post.group_id ? 'group_post' : 'post',
      title: post.title,
      content: post.content || '',
      time: post.created_at,
      groupId: post.group_id,
      groupName: (post.groups as { name?: string } | null)?.name,
      like_count: post.like_count || 0,
      is_pinned: post.is_pinned || false,
    })),
    similarTraders,
  }
}

// 从 trader_snapshots 获取交易员数据（回退方案，当 trader_sources 没有数据时使用）
async function getTraderDetailsFromSnapshots(
  supabase: SupabaseClient,
  traderId: string,
  sourceType: SourceType
) {
  // 获取最新快照数据
  const [
    snapshotResult,
    snapshot7dResult,
    snapshot30dResult,
    arenaFollowersResult,
  ] = await Promise.all([
    // 最新快照（90D）
    supabase
      .from('trader_snapshots')
      .select('roi, pnl, win_rate, max_drawdown, trades_count, followers, captured_at, season_id')
      .eq('source', sourceType)
      .eq('source_trader_id', traderId)
      .order('captured_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    
    // 7天快照
    supabase
      .from('trader_snapshots')
      .select('roi, pnl, win_rate, max_drawdown')
      .eq('source', sourceType)
      .eq('source_trader_id', traderId)
      .eq('season_id', '7D')
      .order('captured_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    
    // 30天快照
    supabase
      .from('trader_snapshots')
      .select('roi, pnl, win_rate, max_drawdown')
      .eq('source', sourceType)
      .eq('source_trader_id', traderId)
      .eq('season_id', '30D')
      .order('captured_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    
    // Arena 粉丝数
    supabase
      .from('trader_follows')
      .select('*', { count: 'exact', head: true })
      .eq('trader_id', traderId),
  ])
  
  const snapshot = snapshotResult.data as SnapshotData | null
  const snapshot7d = snapshot7dResult.data as SnapshotData | null
  const snapshot30d = snapshot30dResult.data as SnapshotData | null
  const arenaFollowers = arenaFollowersResult.count || 0
  
  return {
    profile: {
      handle: traderId,
      id: traderId,
      bio: undefined,
      followers: arenaFollowers,
      avatar_url: undefined,
      isRegistered: false,
      source: sourceType,
    },
    performance: {
      roi_90d: snapshot?.roi || 0,
      roi_7d: snapshot7d?.roi ?? undefined,
      roi_30d: snapshot30d?.roi ?? undefined,
      pnl: snapshot?.pnl ?? undefined,
      win_rate: snapshot?.win_rate ?? undefined,
      max_drawdown: snapshot?.max_drawdown ?? undefined,
      pnl_7d: snapshot7d?.pnl ?? undefined,
      pnl_30d: snapshot30d?.pnl ?? undefined,
      win_rate_7d: snapshot7d?.win_rate ?? undefined,
      win_rate_30d: snapshot30d?.win_rate ?? undefined,
      max_drawdown_7d: snapshot7d?.max_drawdown ?? undefined,
      max_drawdown_30d: snapshot30d?.max_drawdown ?? undefined,
    },
    stats: {
      additionalStats: {
        tradesCount: snapshot?.trades_count ?? undefined,
      },
    },
    portfolio: [],
    positionHistory: [],
    feed: [],
    similarTraders: [],
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ handle: string }> }
) {
  const startTime = Date.now()
  
  try {
    const { handle } = await params
    
    if (!handle) {
      return NextResponse.json({ error: 'Handle is required' }, { status: 400 })
    }

    if (!SUPABASE_URL || !SUPABASE_KEY) {
      return NextResponse.json({ error: 'Missing Supabase config' }, { status: 500 })
    }

    const decodedHandle = decodeURIComponent(handle)
    const cacheKey = `${CACHE_PREFIX}${decodedHandle.toLowerCase()}`
    
    // 检查缓存
    const cached = getServerCache<ReturnType<typeof getTraderDetails>>(cacheKey)
    if (cached) {
      return NextResponse.json({ ...await cached, cached: true })
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
    
    // 查找交易员
    const found = await findTraderSource(supabase, handle)
    
    if (found) {
      // 从 trader_sources 找到了，获取详细数据
      const data = await getTraderDetails(supabase, found.source, found.sourceType)
      
      // 缓存结果
      setServerCache(cacheKey, data, CacheTTL.MEDIUM)
      
      const duration = Date.now() - startTime
      return NextResponse.json({ ...data, cached: false, fetchTime: duration })
    }
    
    // trader_sources 没找到，尝试从 trader_snapshots 获取基本数据
    const snapshotFound = await findTraderFromSnapshots(supabase, handle)
    
    if (!snapshotFound) {
      return NextResponse.json({ 
        error: 'Trader not found',
        handle: decodedHandle,
      }, { status: 404 })
    }
    
    // 从快照获取基本数据
    const data = await getTraderDetailsFromSnapshots(supabase, snapshotFound.traderId, snapshotFound.sourceType)
    
    // 缓存结果
    setServerCache(cacheKey, data, CacheTTL.MEDIUM)
    
    const duration = Date.now() - startTime
    return NextResponse.json({ ...data, cached: false, fetchTime: duration })

  } catch (error) {
    console.error('[Trader API] 错误:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
