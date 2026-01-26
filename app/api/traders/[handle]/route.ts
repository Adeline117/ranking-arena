/**
 * 获取交易员详情 API
 * 
 * 性能优化：
 * - 并行查询所有数据
 * - 内存缓存（5分钟TTL）
 * - 减少数据库往返
 * 
 * 数据包括：
 * - 基本信息、绩效数据
 * - 资产偏好（7D/30D/90D）
 * - 收益率曲线（7D/30D/90D）
 * - 仓位历史记录
 * - 项目表现详细数据（夏普比率、跟单者盈亏等）
 * - tracked_since（Arena 首次追踪时间）
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { getServerCache, setServerCache, CacheTTL } from '@/lib/utils/server-cache'
import { calculateArenaScore, calculateOverallScore } from '@/lib/utils/arena-score'
import { createLogger } from '@/lib/utils/logger'

// 输入验证 schema（支持字母、数字、下划线、连字符、点、中文、0x 地址）
const handleSchema = z.string().min(1).max(255)

// Promise 超时包装器（防止数据库查询永久挂起）
function withTimeout<T>(promise: Promise<T>, ms: number, fallback?: T): Promise<T> {
  const timeout = new Promise<T>((_, reject) =>
    setTimeout(() => reject(new Error(`Query timeout after ${ms}ms`)), ms)
  )
  if (fallback !== undefined) {
    return Promise.race([promise, timeout]).catch(() => fallback)
  }
  return Promise.race([promise, timeout])
}

const logger = createLogger('trader-api')

// Next.js 缓存配置
export const revalidate = 300 // 5分钟

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''

// 支持的交易所 - 需要与数据库中的 source 值保持一致
// 支持的交易所 source 列表
const TRADER_SOURCES = [
  // CEX 合约
  'binance_futures',
  'bitget_futures',
  'bybit',
  'mexc',
  'coinex',
  'okx_web3',
  'kucoin',
  // CEX 现货
  'binance_spot',
  'bitget_spot',
  'binance_web3',
  // DEX / On-chain
  'gmx',
  'hyperliquid',
  'dydx',
] as const
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

interface AssetBreakdownItem {
  symbol: string
  weight_pct: number
  period: string
}

interface EquityCurvePoint {
  data_date: string
  roi_pct: number | null
  pnl_usd: number | null
}

interface PortfolioItem {
  symbol: string | null
  direction: string | null
  invested_pct: number | null
  entry_price: number | null
  pnl: number | null
}

interface PositionHistoryItem {
  symbol: string
  direction: string
  position_type: string | null
  margin_mode: string | null
  open_time: string | null
  close_time: string | null
  entry_price: number | null
  exit_price: number | null
  max_position_size: number | null
  closed_size: number | null
  pnl_usd: number | null
  pnl_pct: number | null
  status: string | null
}

interface StatsDetailData {
  sharpe_ratio: number | null
  copiers_pnl: number | null
  copiers_count: number | null
  winning_positions: number | null
  total_positions: number | null
  avg_holding_time_hours: number | null
  avg_profit: number | null
  avg_loss: number | null
  period: string | null
}

// 安全查询函数 - 处理可能不存在的表
// 使用 PromiseLike 类型以兼容 Supabase 的 PostgrestFilterBuilder
async function safeQuery<T>(
  queryFn: () => PromiseLike<{ data: T | null; error: any }>
): Promise<T | null> {
  try {
    const result = await queryFn()
    // 如果表不存在，error.code 会是 '42P01' 或 message 包含 'does not exist'
    if (result.error && (
      result.error.code === '42P01' || 
      result.error.message?.includes('does not exist') ||
      result.error.message?.includes('relation')
    )) {
      return null
    }
    return result.data
  } catch {
    return null
  }
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
  
  // 🚀 并行获取所有数据（10s 超时保护）
  const [
    snapshotResult,
    snapshot7dResult,
    snapshot30dResult,
    arenaFollowersResult,
    userProfileResult,
    portfolioResult,
    positionHistoryResult,
    postsResult,
    // 新增：资产偏好
    assetBreakdown90dResult,
    assetBreakdown30dResult,
    assetBreakdown7dResult,
    // 新增：收益率曲线
    equityCurve90dResult,
    equityCurve30dResult,
    equityCurve7dResult,
    // 新增：详细统计
    statsDetailResult,
    // 新增：tracked_since
    trackedSinceResult,
  ] = await withTimeout(Promise.all([
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
    
    // 当前持仓数据 (表可能不存在)
    safeQuery(() => supabase
      .from('trader_portfolio')
      .select('symbol, direction, invested_pct, entry_price, pnl')
      .eq('source', sourceType)
      .eq('source_trader_id', traderId)
      .order('captured_at', { ascending: false })
      .limit(50)),
    
    // 仓位历史记录（扩展字段）(表可能不存在)
    safeQuery(() => supabase
      .from('trader_position_history')
      .select('symbol, direction, position_type, margin_mode, open_time, close_time, entry_price, exit_price, max_position_size, closed_size, pnl_usd, pnl_pct, status')
      .eq('source', sourceType)
      .eq('source_trader_id', traderId)
      .order('open_time', { ascending: false })
      .limit(100)),
    
    // 帖子
    supabase
      .from('posts')
      .select('id, title, content, created_at, group_id, like_count, is_pinned, groups(name)')
      .eq('author_handle', traderHandle)
      .order('created_at', { ascending: false })
      .limit(20),
    
    // 资产偏好 90D (表可能不存在)
    safeQuery(() => supabase
      .from('trader_asset_breakdown')
      .select('symbol, weight_pct, period')
      .eq('source', sourceType)
      .eq('source_trader_id', traderId)
      .eq('period', '90D')
      .order('weight_pct', { ascending: false })
      .limit(20)),
    
    // 资产偏好 30D (表可能不存在)
    safeQuery(() => supabase
      .from('trader_asset_breakdown')
      .select('symbol, weight_pct, period')
      .eq('source', sourceType)
      .eq('source_trader_id', traderId)
      .eq('period', '30D')
      .order('weight_pct', { ascending: false })
      .limit(20)),
    
    // 资产偏好 7D (表可能不存在)
    safeQuery(() => supabase
      .from('trader_asset_breakdown')
      .select('symbol, weight_pct, period')
      .eq('source', sourceType)
      .eq('source_trader_id', traderId)
      .eq('period', '7D')
      .order('weight_pct', { ascending: false })
      .limit(20)),
    
    // 收益率曲线 90D (表可能不存在)
    safeQuery(() => supabase
      .from('trader_equity_curve')
      .select('data_date, roi_pct, pnl_usd')
      .eq('source', sourceType)
      .eq('source_trader_id', traderId)
      .eq('period', '90D')
      .order('data_date', { ascending: true })
      .limit(90)),
    
    // 收益率曲线 30D (表可能不存在)
    safeQuery(() => supabase
      .from('trader_equity_curve')
      .select('data_date, roi_pct, pnl_usd')
      .eq('source', sourceType)
      .eq('source_trader_id', traderId)
      .eq('period', '30D')
      .order('data_date', { ascending: true })
      .limit(30)),
    
    // 收益率曲线 7D (表可能不存在)
    safeQuery(() => supabase
      .from('trader_equity_curve')
      .select('data_date, roi_pct, pnl_usd')
      .eq('source', sourceType)
      .eq('source_trader_id', traderId)
      .eq('period', '7D')
      .order('data_date', { ascending: true })
      .limit(7)),
    
    // 详细统计数据 (表可能不存在)
    safeQuery(() => supabase
      .from('trader_stats_detail')
      .select('sharpe_ratio, copiers_pnl, copiers_count, winning_positions, total_positions, avg_holding_time_hours, avg_profit, avg_loss, period')
      .eq('source', sourceType)
      .eq('source_trader_id', traderId)
      .order('captured_at', { ascending: false })
      .limit(3)),
    
    // tracked_since（首次抓取时间）
    supabase
      .from('trader_snapshots')
      .select('captured_at')
      .eq('source', sourceType)
      .eq('source_trader_id', traderId)
      .order('captured_at', { ascending: true })
      .limit(1)
      .maybeSingle(),
  ]), 10000) // 10s timeout

  const snapshot = snapshotResult.data as SnapshotData | null
  const snapshot7d = snapshot7dResult.data as SnapshotData | null
  const snapshot30d = snapshot30dResult.data as SnapshotData | null
  const arenaFollowers = arenaFollowersResult.count || 0
  const userProfile = userProfileResult.data
  // 使用 safeQuery 返回的结果（可能是 null 或数据数组）
  const portfolioData = (portfolioResult || []) as PortfolioItem[]
  const positionHistoryData = (positionHistoryResult || []) as PositionHistoryItem[]
  const posts = postsResult.data || []
  
  // 资产偏好数据（safeQuery 返回 null 或数据）
  const assetBreakdown90d = (assetBreakdown90dResult || []) as AssetBreakdownItem[]
  const assetBreakdown30d = (assetBreakdown30dResult || []) as AssetBreakdownItem[]
  const assetBreakdown7d = (assetBreakdown7dResult || []) as AssetBreakdownItem[]
  
  // 收益率曲线数据
  const equityCurve90d = (equityCurve90dResult || []) as EquityCurvePoint[]
  const equityCurve30d = (equityCurve30dResult || []) as EquityCurvePoint[]
  const equityCurve7d = (equityCurve7dResult || []) as EquityCurvePoint[]
  
  // 详细统计数据
  const statsDetailList = (statsDetailResult || []) as StatsDetailData[]
  const statsDetail90d = statsDetailList.find(s => s.period === '90D') || statsDetailList[0]
  const statsDetail30d = statsDetailList.find(s => s.period === '30D')
  const statsDetail7d = statsDetailList.find(s => s.period === '7D')
  
  // tracked_since
  const trackedSince = trackedSinceResult.data?.captured_at || null
  
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
  
  // 计算各时间段的 Arena Score
  // 注意数据转换：数据库中 roi 和 win_rate 需要 *100 转为百分比
  // max_drawdown 已经是百分比形式
  // 辅助函数：标准化 win_rate 为百分比
  // binance_futures 存储小数(0.85)，bitget/bybit 存储百分比(85)
  const normalizeWinRate = (wr: number | null): number | null => {
    if (wr == null) return null
    return wr <= 1 ? wr * 100 : wr  // 如果 <= 1 则是小数，需要 * 100
  }

  const score90d = snapshot?.roi != null && snapshot?.pnl != null
    ? calculateArenaScore({
        roi: snapshot.roi * 100,              // 数据库存储的是 ROI/100
        pnl: snapshot.pnl,
        maxDrawdown: snapshot.max_drawdown,   // 已经是百分比
        winRate: normalizeWinRate(snapshot.win_rate),
      }, '90D')
    : null

  const score30d = snapshot30d?.roi != null && snapshot30d?.pnl != null
    ? calculateArenaScore({
        roi: snapshot30d.roi * 100,
        pnl: snapshot30d.pnl,
        maxDrawdown: snapshot30d.max_drawdown,
        winRate: normalizeWinRate(snapshot30d.win_rate),
      }, '30D')
    : null

  const score7d = snapshot7d?.roi != null && snapshot7d?.pnl != null
    ? calculateArenaScore({
        roi: snapshot7d.roi * 100,
        pnl: snapshot7d.pnl,
        maxDrawdown: snapshot7d.max_drawdown,
        winRate: normalizeWinRate(snapshot7d.win_rate),
      }, '7D')
    : null

  // 计算总体分数
  const overallScore = calculateOverallScore({
    score7d: score7d?.meetsThreshold ? score7d.totalScore : null,
    score30d: score30d?.meetsThreshold ? score30d.totalScore : null,
    score90d: score90d?.meetsThreshold ? score90d.totalScore : null,
  })

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
      win_rate: normalizeWinRate(snapshot?.win_rate ?? null) ?? undefined,
      max_drawdown: snapshot?.max_drawdown ?? undefined,
      pnl_7d: snapshot7d?.pnl ?? undefined,
      pnl_30d: snapshot30d?.pnl ?? undefined,
      win_rate_7d: normalizeWinRate(snapshot7d?.win_rate ?? null) ?? undefined,
      win_rate_30d: normalizeWinRate(snapshot30d?.win_rate ?? null) ?? undefined,
      max_drawdown_7d: snapshot7d?.max_drawdown ?? undefined,
      max_drawdown_30d: snapshot30d?.max_drawdown ?? undefined,
      // Arena Score
      arena_score_90d: score90d?.totalScore ?? undefined,
      arena_score_30d: score30d?.totalScore ?? undefined,
      arena_score_7d: score7d?.totalScore ?? undefined,
      overall_score: overallScore,
      // 详细统计
      sharpe_ratio: statsDetail90d?.sharpe_ratio ?? undefined,
      sharpe_ratio_30d: statsDetail30d?.sharpe_ratio ?? undefined,
      sharpe_ratio_7d: statsDetail7d?.sharpe_ratio ?? undefined,
      // 获胜仓位和总仓位（按周期）
      winning_positions: statsDetail90d?.winning_positions ?? undefined,
      winning_positions_30d: statsDetail30d?.winning_positions ?? undefined,
      winning_positions_7d: statsDetail7d?.winning_positions ?? undefined,
      total_positions: statsDetail90d?.total_positions ?? undefined,
      total_positions_30d: statsDetail30d?.total_positions ?? undefined,
      total_positions_7d: statsDetail7d?.total_positions ?? undefined,
    },
    stats: {
      additionalStats: {
        tradesCount: snapshot?.trades_count ?? undefined,
        avgHoldingTime: statsDetail90d?.avg_holding_time_hours 
          ? `${Math.round(statsDetail90d.avg_holding_time_hours)}h` 
          : undefined,
        avgProfit: statsDetail90d?.avg_profit ?? undefined,
        avgLoss: statsDetail90d?.avg_loss ?? undefined,
        trackedSince: trackedSince 
          ? new Date(trackedSince).toLocaleDateString('zh-CN', { year: 'numeric', month: 'short', day: 'numeric' })
          : undefined,
        maxDrawdown: snapshot?.max_drawdown ?? undefined,
      },
      trading: {
        totalTrades12M: snapshot?.trades_count ?? 0,
        avgProfit: statsDetail90d?.avg_profit ?? 0,
        avgLoss: statsDetail90d?.avg_loss ?? 0,
        profitableTradesPct: normalizeWinRate(snapshot?.win_rate ?? null) ?? 0,
        winningPositions: statsDetail90d?.winning_positions ?? undefined,
        totalPositions: statsDetail90d?.total_positions ?? undefined,
      },
      frequentlyTraded: assetBreakdown90d.map(item => ({
        symbol: item.symbol,
        weightPct: item.weight_pct,
        count: 0,
        avgProfit: 0,
        avgLoss: 0,
        profitablePct: 0,
      })),
    },
    // 资产偏好（按时间段）
    assetBreakdown: {
      '90D': assetBreakdown90d.map(item => ({ symbol: item.symbol, weightPct: item.weight_pct })),
      '30D': assetBreakdown30d.map(item => ({ symbol: item.symbol, weightPct: item.weight_pct })),
      '7D': assetBreakdown7d.map(item => ({ symbol: item.symbol, weightPct: item.weight_pct })),
    },
    // 收益率曲线（按时间段）
    equityCurve: {
      '90D': equityCurve90d.map(item => ({ 
        date: item.data_date, 
        roi: item.roi_pct ?? 0, 
        pnl: item.pnl_usd ?? 0 
      })),
      '30D': equityCurve30d.map(item => ({ 
        date: item.data_date, 
        roi: item.roi_pct ?? 0, 
        pnl: item.pnl_usd ?? 0 
      })),
      '7D': equityCurve7d.map(item => ({ 
        date: item.data_date, 
        roi: item.roi_pct ?? 0, 
        pnl: item.pnl_usd ?? 0 
      })),
    },
    // 当前持仓
    portfolio: portfolioData.map((item) => ({
      market: item.symbol || '',
      direction: item.direction === 'short' ? 'short' : 'long',
      invested: item.invested_pct ?? 0,
      pnl: item.pnl ?? 0,
      value: item.invested_pct ?? 0,
      price: item.entry_price ?? 0,
    })),
    // 仓位历史记录（详细版）
    positionHistory: positionHistoryData.map((item) => ({
      symbol: item.symbol || '',
      direction: item.direction === 'short' ? 'short' : 'long',
      positionType: item.position_type || 'perpetual',
      marginMode: item.margin_mode || 'cross',
      openTime: item.open_time || '',
      closeTime: item.close_time || '',
      entryPrice: item.entry_price || 0,
      exitPrice: item.exit_price || 0,
      maxPositionSize: item.max_position_size || 0,
      closedSize: item.closed_size || 0,
      pnlUsd: item.pnl_usd || 0,
      pnlPct: item.pnl_pct || 0,
      status: item.status || 'closed',
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
    // tracked_since
    trackedSince: trackedSince || undefined,
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
    trackedSinceResult,
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
    
    // tracked_since
    supabase
      .from('trader_snapshots')
      .select('captured_at')
      .eq('source', sourceType)
      .eq('source_trader_id', traderId)
      .order('captured_at', { ascending: true })
      .limit(1)
      .maybeSingle(),
  ])
  
  const snapshot = snapshotResult.data as SnapshotData | null
  const snapshot7d = snapshot7dResult.data as SnapshotData | null
  const snapshot30d = snapshot30dResult.data as SnapshotData | null
  const arenaFollowers = arenaFollowersResult.count || 0
  const trackedSince = trackedSinceResult.data?.captured_at || null
  
  // 辅助函数：标准化 win_rate 为百分比
  // binance_futures 存储小数(0.85)，bitget/bybit 存储百分比(85)
  const normalizeWinRate = (wr: number | null): number | null => {
    if (wr == null) return null
    return wr <= 1 ? wr * 100 : wr  // 如果 <= 1 则是小数，需要 * 100
  }

  // 计算各时间段的 Arena Score
  const score90d = snapshot?.roi != null && snapshot?.pnl != null
    ? calculateArenaScore({
        roi: snapshot.roi * 100,
        pnl: snapshot.pnl,
        maxDrawdown: snapshot.max_drawdown,
        winRate: normalizeWinRate(snapshot.win_rate),
      }, '90D')
    : null

  const score30d = snapshot30d?.roi != null && snapshot30d?.pnl != null
    ? calculateArenaScore({
        roi: snapshot30d.roi * 100,
        pnl: snapshot30d.pnl,
        maxDrawdown: snapshot30d.max_drawdown,
        winRate: normalizeWinRate(snapshot30d.win_rate),
      }, '30D')
    : null

  const score7d = snapshot7d?.roi != null && snapshot7d?.pnl != null
    ? calculateArenaScore({
        roi: snapshot7d.roi * 100,
        pnl: snapshot7d.pnl,
        maxDrawdown: snapshot7d.max_drawdown,
        winRate: normalizeWinRate(snapshot7d.win_rate),
      }, '7D')
    : null

  // 计算总体分数
  const overallScore = calculateOverallScore({
    score7d: score7d?.meetsThreshold ? score7d.totalScore : null,
    score30d: score30d?.meetsThreshold ? score30d.totalScore : null,
    score90d: score90d?.meetsThreshold ? score90d.totalScore : null,
  })

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
      win_rate: normalizeWinRate(snapshot?.win_rate ?? null) ?? undefined,
      max_drawdown: snapshot?.max_drawdown ?? undefined,
      pnl_7d: snapshot7d?.pnl ?? undefined,
      pnl_30d: snapshot30d?.pnl ?? undefined,
      win_rate_7d: normalizeWinRate(snapshot7d?.win_rate ?? null) ?? undefined,
      win_rate_30d: normalizeWinRate(snapshot30d?.win_rate ?? null) ?? undefined,
      max_drawdown_7d: snapshot7d?.max_drawdown ?? undefined,
      max_drawdown_30d: snapshot30d?.max_drawdown ?? undefined,
      // Arena Score
      arena_score_90d: score90d?.totalScore ?? undefined,
      arena_score_30d: score30d?.totalScore ?? undefined,
      arena_score_7d: score7d?.totalScore ?? undefined,
      overall_score: overallScore,
    },
    stats: {
      additionalStats: {
        tradesCount: snapshot?.trades_count ?? undefined,
        trackedSince: trackedSince 
          ? new Date(trackedSince).toLocaleDateString('zh-CN', { year: 'numeric', month: 'short', day: 'numeric' })
          : undefined,
        maxDrawdown: snapshot?.max_drawdown ?? undefined,
      },
      trading: {
        totalTrades12M: snapshot?.trades_count ?? 0,
        avgProfit: 0,
        avgLoss: 0,
        profitableTradesPct: normalizeWinRate(snapshot?.win_rate ?? null) ?? 0,
      },
      frequentlyTraded: [],
    },
    assetBreakdown: { '90D': [], '30D': [], '7D': [] },
    equityCurve: { '90D': [], '30D': [], '7D': [] },
    portfolio: [],
    positionHistory: [],
    feed: [],
    similarTraders: [],
    trackedSince: trackedSince || undefined,
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ handle: string }> }
) {
  const startTime = Date.now()
  
  try {
    const { handle: rawHandle } = await params

    const parsed = handleSchema.safeParse(rawHandle)
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid handle parameter' }, { status: 400 })
    }
    const handle = parsed.data

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
      logger.warn(`No trader found for handle: ${decodedHandle}`)
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

  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    logger.error('Trader API error', { error: errorMessage })
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
