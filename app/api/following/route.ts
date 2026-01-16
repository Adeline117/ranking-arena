/**
 * 获取用户关注的交易员列表 API
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ''

const ALL_SOURCES = ['binance', 'binance_web3', 'bybit', 'bitget', 'okx', 'kucoin', 'gate', 'mexc', 'coinex']

export async function GET(request: NextRequest) {
  try {
    const userId = request.nextUrl.searchParams.get('userId')
    
    if (!userId) {
      return NextResponse.json({ error: 'Missing userId' }, { status: 400 })
    }

    if (!SUPABASE_URL || !SUPABASE_KEY) {
      return NextResponse.json({ error: 'Missing Supabase config' }, { status: 500 })
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

    // 1. 获取用户关注的所有交易员ID
    const { data: follows, error: followsError } = await supabase
      .from('trader_follows')
      .select('trader_id, source')
      .eq('user_id', userId)

    if (followsError) {
      console.error('[Following API] Error fetching follows:', followsError)
      return NextResponse.json({ error: followsError.message }, { status: 500 })
    }

    if (!follows || follows.length === 0) {
      return NextResponse.json({ traders: [], count: 0 })
    }

    const traderIds = follows.map(f => f.trader_id)
    console.log('[Following API] Found trader IDs:', traderIds)

    // 2. 并行获取 trader_sources 和 trader_snapshots 数据
    const [sourcesResult, snapshotsResult] = await Promise.all([
      supabase
        .from('trader_sources')
        .select('source_trader_id, handle, source, profile_url')
        .in('source_trader_id', traderIds),
      supabase
        .from('trader_snapshots')
        .select('source_trader_id, source, rank, roi, followers, pnl, win_rate, captured_at')
        .in('source_trader_id', traderIds)
        .in('source', ALL_SOURCES)
        .order('captured_at', { ascending: false })
        .limit(5000)
    ])

    const sources = sourcesResult.data || []
    const allSnapshots = snapshotsResult.data || []

    console.log('[Following API] Found sources:', sources.length)
    console.log('[Following API] Found snapshots:', allSnapshots.length)

    // 3. 构建 handle 映射
    const sourcesMap = new Map<string, { handle: string; source: string; avatar_url?: string }>()
    sources.forEach((s) => {
      sourcesMap.set(s.source_trader_id, { 
        handle: s.handle || s.source_trader_id, 
        source: s.source,
        avatar_url: s.profile_url || undefined
      })
    })

    // 4. 为每个交易员获取最新的快照
    const traders: Array<{
      id: string
      handle: string
      roi: number
      pnl?: number
      win_rate: number
      followers: number
      source: string
      avatar_url?: string
    }> = []

    if (allSnapshots.length > 0) {
      const latestSnapshotsMap = new Map<string, typeof allSnapshots[0]>()
      
      for (const snapshot of allSnapshots) {
        const key = snapshot.source_trader_id
        if (!latestSnapshotsMap.has(key)) {
          latestSnapshotsMap.set(key, snapshot)
        } else {
          const existing = latestSnapshotsMap.get(key)!
          if ((snapshot.roi || 0) > (existing.roi || 0)) {
            latestSnapshotsMap.set(key, snapshot)
          }
        }
      }
      
      for (const [traderId, snapshot] of latestSnapshotsMap) {
        const sourceInfo = sourcesMap.get(traderId)
        traders.push({
          id: traderId,
          handle: sourceInfo?.handle || traderId,
          roi: snapshot.roi || 0,
          pnl: snapshot.pnl !== null && snapshot.pnl !== undefined ? snapshot.pnl : undefined,
          win_rate: snapshot.win_rate !== null && snapshot.win_rate !== undefined ? snapshot.win_rate : 0,
          followers: snapshot.followers || 0,
          source: snapshot.source || 'binance',
          avatar_url: sourceInfo?.avatar_url
        })
      }
    } else {
      // 如果没有快照数据，至少返回交易员基本信息
      for (const traderId of traderIds) {
        const sourceInfo = sourcesMap.get(traderId)
        traders.push({
          id: traderId,
          handle: sourceInfo?.handle || traderId,
          roi: 0,
          win_rate: 0,
          followers: 0,
          source: sourceInfo?.source || 'binance',
          avatar_url: sourceInfo?.avatar_url
        })
      }
    }

    // 按 ROI 降序排序
    traders.sort((a, b) => b.roi - a.roi)

    return NextResponse.json({ 
      traders, 
      count: traders.length,
      debug: {
        followsCount: follows.length,
        sourcesCount: sources.length,
        snapshotsCount: allSnapshots.length,
        traderIds
      }
    })
  } catch (error) {
    console.error('[Following API] Error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
