/**
 * 获取排行榜交易员数据 API
 * 合并所有交易所数据，使用 Arena Score 排名算法
 * 支持 7D/30D/90D 时间段分别显示
 */

import { NextResponse } from 'next/server'
import { withPublic } from '@/lib/api/middleware'
import { 
  calculateArenaScore, 
  ARENA_CONFIG, 
  type Period,
  type ArenaScoreResult 
} from '@/lib/utils/arena-score'

export const dynamic = 'force-dynamic'

// 支持的交易所
const ALL_SOURCES = ['binance', 'binance_web3', 'bybit', 'bitget', 'mexc', 'coinex']

// 使用 season_id 区分时间段的交易所
const SEASON_ID_SOURCES = ['binance', 'bybit', 'bitget', 'mexc', 'binance_web3', 'coinex']

interface TraderData {
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
  arena_score?: number
  return_score?: number
  drawdown_score?: number
  stability_score?: number
}

export const GET = withPublic(
  async ({ supabase, request }) => {
    // 获取查询参数
    const searchParams = request.nextUrl.searchParams
    const timeRange = (searchParams.get('timeRange') || '90D') as Period

    const allTraders: TraderData[] = []

    // 并行获取所有交易所数据
    const sourcePromises = ALL_SOURCES.map(async (source) => {
      const useSeasonId = SEASON_ID_SOURCES.includes(source)

      // 获取最新 captured_at
      let timestampQuery = supabase
        .from('trader_snapshots')
        .select('captured_at')
        .eq('source', source)
        .order('captured_at', { ascending: false })
        .limit(1)

      if (useSeasonId) {
        timestampQuery = timestampQuery.eq('season_id', timeRange)
      }

      const { data: latestSnapshot } = await timestampQuery.maybeSingle()
      if (!latestSnapshot) return []

      // 查询快照数据
      let snapshotQuery = supabase
        .from('trader_snapshots')
        .select('source_trader_id, rank, roi, pnl, followers, win_rate, max_drawdown, trades_count')
        .eq('source', source)
        .eq('captured_at', latestSnapshot.captured_at)

      if (useSeasonId) {
        snapshotQuery = snapshotQuery.eq('season_id', timeRange)
      }

      snapshotQuery = snapshotQuery.order('roi', { ascending: false }).limit(150)

      const { data: snapshots, error } = await snapshotQuery

      if (error || !snapshots?.length) {
        if (error) console.error(`[Traders API] ${source} 查询错误:`, error.message)
        return []
      }

      // 批量获取 handles
      const traderIds = snapshots.map(s => s.source_trader_id)
      const { data: sources } = await supabase
        .from('trader_sources')
        .select('source_trader_id, handle, profile_url')
        .eq('source', source)
        .in('source_trader_id', traderIds)

      const handleMap = new Map<string, { handle: string | null; avatar_url: string | null }>()
      sources?.forEach((s: { source_trader_id: string; handle: string | null; profile_url: string | null }) => {
        // profile_url 存储的是头像图片 URL（由抓取脚本保存）
        handleMap.set(s.source_trader_id, { handle: s.handle, avatar_url: s.profile_url })
      })

      // 构建交易员数据
      return snapshots.map(item => {
        const info = handleMap.get(item.source_trader_id) || { handle: null, avatar_url: null }
        return {
          id: item.source_trader_id,
          handle: info.handle || item.source_trader_id,
          roi: item.roi ?? 0,
          pnl: item.pnl ?? 0,
          win_rate: item.win_rate ?? 0,
          max_drawdown: item.max_drawdown,
          trades_count: item.trades_count,
          followers: item.followers || 0,
          source,
          avatar_url: info.avatar_url,
        }
      })
    })

    // 等待所有查询完成
    const results = await Promise.all(sourcePromises)
    results.forEach(traders => allTraders.push(...traders))

    // 使用 Arena Score 排名
    // 1. 计算每个交易员的 Arena Score
    // 2. 过滤未达 PnL 门槛的交易员
    // 3. 按 Arena Score 降序排序
    
    const pnlThreshold = ARENA_CONFIG.PNL_THRESHOLD[timeRange]
    
    const scoredTraders = allTraders
      .map(trader => {
        const scoreResult = calculateArenaScore(
          {
            roi: trader.roi,
            pnl: trader.pnl,
            maxDrawdown: trader.max_drawdown,
            winRate: trader.win_rate,
          },
          timeRange
        )
        
          return {
          ...trader,
          arena_score: scoreResult.totalScore,
          return_score: scoreResult.returnScore,
          drawdown_score: scoreResult.drawdownScore,
          stability_score: scoreResult.stabilityScore,
          _meetsThreshold: scoreResult.meetsThreshold,
          }
        })
      // 过滤未达门槛的（Bybit 的 PnL 是跟单者盈亏，特殊处理）
      .filter(t => t.source === 'bybit' || t._meetsThreshold)
      // 按 Arena Score 降序排序
        .sort((a, b) => {
        // 主排序：Arena Score 降序
        if (b.arena_score !== a.arena_score) {
          return b.arena_score - a.arena_score
        }
        // 次排序：回撤小的优先
        const mddA = Math.abs(a.max_drawdown ?? Infinity)
        const mddB = Math.abs(b.max_drawdown ?? Infinity)
        return mddA - mddB
        })

    // 取前 100 名，移除内部字段
    const topTraders = scoredTraders.slice(0, 100).map(({ _meetsThreshold, ...t }) => t)

    const response = NextResponse.json({ 
      traders: topTraders,
      timeRange,
      totalCount: allTraders.length,
      rankingMode: 'arena_score',
      pnlThreshold,
    })
    
    // 添加缓存头，提高页面加载速度
    response.headers.set('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300')
    
    return response
  },
  { name: 'traders', rateLimit: 'read' }
)
