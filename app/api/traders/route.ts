/**
 * 获取排行榜交易员数据 API
 * 合并所有交易所数据，使用风险调整排名算法
 * 支持 7D/30D/90D 时间段分别显示
 */

import { NextResponse } from 'next/server'
import { withPublic } from '@/lib/api/middleware'
import { rankTraders, simpleRankTraders, type TraderRankingData } from '@/lib/utils/ranking'

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
  risk_adjusted_score?: number
  stability_score?: number
  is_suspicious?: boolean
}

export const GET = withPublic(
  async ({ supabase, request }) => {
    // 获取查询参数
    const searchParams = request.nextUrl.searchParams
    const timeRange = searchParams.get('timeRange') || '90D'
    // 默认使用简单排名，加 ?ranking=advanced 启用高级排名
    const useAdvancedRanking = searchParams.get('ranking') === 'advanced'

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

    // 使用排名算法
    let rankedTraders: TraderData[]
    
    if (useAdvancedRanking) {
      // 高级排名算法（风险调整）
      const rankingData: TraderRankingData[] = allTraders.map(t => ({
        id: t.id,
        roi: t.roi,
        pnl: t.pnl,
        win_rate: t.win_rate,
        max_drawdown: t.max_drawdown,
        trades_count: t.trades_count,
        source: t.source,
      }))

      const ranked = rankTraders(rankingData)
      
      // 合并排名结果
      const rankedMap = new Map(ranked.map(r => [r.id, r]))
      rankedTraders = allTraders
        .filter(t => rankedMap.has(t.id))
        .map(t => {
          const rankInfo = rankedMap.get(t.id)!
          return {
            ...t,
            risk_adjusted_score: rankInfo.risk_adjusted_score,
            stability_score: rankInfo.stability_score,
            is_suspicious: rankInfo.is_suspicious,
          }
        })
        .sort((a, b) => {
          const rankA = rankedMap.get(a.id)!.rank
          const rankB = rankedMap.get(b.id)!.rank
          return rankA - rankB
        })
    } else {
      // 简单排名（保持向后兼容）
      const rankingData: TraderRankingData[] = allTraders.map(t => ({
        id: t.id,
        roi: t.roi,
        pnl: t.pnl,
        win_rate: t.win_rate,
        max_drawdown: t.max_drawdown,
        trades_count: t.trades_count,
        source: t.source,
      }))

      const sorted = simpleRankTraders(rankingData)
      const sortedIds = new Set(sorted.map(s => s.id))
      
      rankedTraders = allTraders
        .filter(t => sortedIds.has(t.id))
        .sort((a, b) => {
          const idxA = sorted.findIndex(s => s.id === a.id)
          const idxB = sorted.findIndex(s => s.id === b.id)
          return idxA - idxB
        })
    }

    // 取前 100 名
    const topTraders = rankedTraders.slice(0, 100)

    return NextResponse.json({ 
      traders: topTraders,
      timeRange,
      totalCount: allTraders.length,
      rankingMode: useAdvancedRanking ? 'risk_adjusted' : 'simple',
    })
  },
  { name: 'traders', rateLimit: 'read' }
)
