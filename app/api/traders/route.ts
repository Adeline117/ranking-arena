/**
 * 获取排行榜交易员数据 API
 * 合并所有交易所数据，按 ROI 排序
 * 支持 7D/30D/90D 时间段分别显示
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''

// 支持的交易所
const ALL_SOURCES = ['binance', 'binance_web3', 'bybit', 'bitget', 'mexc', 'coinex']

// 使用 season_id 区分时间段的交易所（每个时间段有独立记录）
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
}

export async function GET(request: NextRequest) {
  try {
    if (!SUPABASE_URL || !SUPABASE_KEY) {
      return NextResponse.json({ error: 'Missing Supabase config' }, { status: 500 })
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
    
    // 获取查询参数
    const searchParams = request.nextUrl.searchParams
    const timeRange = searchParams.get('timeRange') || '90D' // 7D, 30D, 90D

    const allTraders: TraderData[] = []

    // 遍历所有交易所获取数据
    for (const source of ALL_SOURCES) {
      // 判断数据存储方式
      const useSeasonId = SEASON_ID_SOURCES.includes(source)

      // 获取最新的 captured_at
      let timestampQuery = supabase
        .from('trader_snapshots')
        .select('captured_at')
        .eq('source', source)
        .order('captured_at', { ascending: false })
        .limit(1)

      // 对于使用 season_id 的交易所，按时间段过滤
      if (useSeasonId) {
        timestampQuery = timestampQuery.eq('season_id', timeRange)
      }

      const { data: latestSnapshot } = await timestampQuery.maybeSingle()

      if (!latestSnapshot) continue

      // 查询快照数据 - 只查询存在的字段
      let snapshotQuery = supabase
        .from('trader_snapshots')
        .select('source_trader_id, rank, roi, pnl, followers, win_rate, max_drawdown, trades_count')
        .eq('source', source)
        .eq('captured_at', latestSnapshot.captured_at)

      // 对于使用 season_id 的交易所，按时间段过滤
      if (useSeasonId) {
        snapshotQuery = snapshotQuery.eq('season_id', timeRange)
      }

      // PnL 过滤 - Bybit 的 PnL 是 Followers' PnL（跟单者盈亏），不适用于筛选
      // 其他交易所使用 PnL >= 1000 过滤
      if (source !== 'bybit') {
        snapshotQuery = snapshotQuery.gte('pnl', 1000)
      }

      // 排序
      snapshotQuery = snapshotQuery.order('roi', { ascending: false }).limit(100)

      const { data: snapshots, error } = await snapshotQuery

      if (error) {
        console.error(`[Traders API] ${source} 查询错误:`, error.message)
        continue
      }

      if (!snapshots || snapshots.length === 0) continue

      // 获取 handles
      const traderIds = snapshots.map(s => s.source_trader_id)
      const { data: sources } = await supabase
        .from('trader_sources')
        .select('source_trader_id, handle, profile_url')
        .eq('source', source)
        .in('source_trader_id', traderIds)

      const handleMap = new Map()
      if (sources) {
        sources.forEach((s: { source_trader_id: string; handle: string | null; profile_url: string | null }) => {
          handleMap.set(s.source_trader_id, { handle: s.handle, avatar_url: s.profile_url })
        })
      }

      // 构建交易员数据
      for (const item of snapshots) {
        const info = handleMap.get(item.source_trader_id) || {}
        
        allTraders.push({
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
        })
      }
    }

    // 排序规则（与前端 RankingTable 一致）：
    // 1. ROI 降序
    // 2. ROI 相同时，回撤小的靠前
    // 3. 回撤也相同时，交易次数多的靠前
    allTraders.sort((a, b) => {
      // 1. ROI 降序
      if (b.roi !== a.roi) return b.roi - a.roi
      
      // 2. 回撤小的靠前（回撤越小越好）
      const mddA = a.max_drawdown ?? Infinity
      const mddB = b.max_drawdown ?? Infinity
      if (mddA !== mddB) return mddA - mddB
      
      // 3. 交易次数多的靠前
      const tradesA = a.trades_count ?? 0
      const tradesB = b.trades_count ?? 0
      return tradesB - tradesA
    })

    // 严格取前 100 名
    const topTraders = allTraders.slice(0, 100)

    console.log(`[Traders API] ${timeRange} 合并 ${ALL_SOURCES.length} 个交易所，共 ${allTraders.length} 条，返回前 ${topTraders.length} 条`)

    return NextResponse.json({ 
      traders: topTraders,
      timeRange,
      totalCount: allTraders.length,
    })
  } catch (error) {
    console.error('[Traders API] 错误:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
