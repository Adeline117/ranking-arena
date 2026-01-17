/**
 * 获取用户关注列表 API（统一返回交易员和用户）
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ''

const ALL_SOURCES = ['binance', 'binance_web3', 'bybit', 'bitget', 'okx', 'kucoin', 'gate', 'mexc', 'coinex']

// 统一的关注项类型
type FollowItem = {
  id: string
  handle: string
  type: 'trader' | 'user'
  avatar_url?: string
  bio?: string
  // 交易员特有字段
  roi?: number
  pnl?: number
  win_rate?: number
  followers?: number
  source?: string
  // 排序用
  followed_at?: string
}

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

    // 并行获取关注的交易员和用户
    const [traderFollowsResult, userFollowsResult] = await Promise.all([
      // 获取关注的交易员
      supabase
        .from('trader_follows')
        .select('trader_id, source, created_at')
        .eq('user_id', userId),
      // 获取关注的用户
      supabase
        .from('user_follows')
        .select(`
          created_at,
          following:user_profiles!user_follows_following_id_fkey(
            id,
            handle,
            bio,
            avatar_url
          )
        `)
        .eq('follower_id', userId)
    ])

    const traderFollows = traderFollowsResult.data || []
    const userFollows = userFollowsResult.data || []
    
    const items: FollowItem[] = []

    // 处理关注的用户
    for (const follow of userFollows) {
      const user = follow.following as any
      if (user && user.id) {
        items.push({
          id: user.id,
          handle: user.handle || '未命名用户',
          type: 'user',
          avatar_url: user.avatar_url,
          bio: user.bio,
          followed_at: follow.created_at
        })
      }
    }

    // 处理关注的交易员
    if (traderFollows.length > 0) {
      const traderIds = traderFollows.map(f => f.trader_id)
      const followedAtMap = new Map(traderFollows.map(f => [f.trader_id, f.created_at]))

      // 获取交易员信息
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

      // 构建映射
      const sourcesMap = new Map<string, { handle: string; source: string; avatar_url?: string }>()
      sources.forEach((s) => {
        sourcesMap.set(s.source_trader_id, { 
          handle: s.handle || s.source_trader_id, 
          source: s.source,
          avatar_url: s.profile_url || undefined
        })
      })

      // 为每个交易员获取最新的快照
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

      // 添加交易员到列表
      for (const traderId of traderIds) {
        const sourceInfo = sourcesMap.get(traderId)
        const snapshot = latestSnapshotsMap.get(traderId)
        
        // 如果在 trader_sources 和 trader_snapshots 中都找不到，跳过这个记录
        // （可能是错误存入的用户 UUID）
        if (!sourceInfo && !snapshot) {
          console.warn(`[Following API] Trader not found in trader_sources or trader_snapshots: ${traderId}`)
          continue
        }
        
        items.push({
          id: traderId,
          handle: sourceInfo?.handle || traderId,
          type: 'trader',
          avatar_url: sourceInfo?.avatar_url,
          roi: snapshot?.roi || 0,
          pnl: snapshot?.pnl !== null && snapshot?.pnl !== undefined ? snapshot.pnl : undefined,
          win_rate: snapshot?.win_rate !== null && snapshot?.win_rate !== undefined ? snapshot.win_rate : 0,
          followers: snapshot?.followers || 0,
          source: snapshot?.source || sourceInfo?.source || 'binance',
          followed_at: followedAtMap.get(traderId)
        })
      }
    }

    // 按关注时间降序排序（最近关注的在前）
    items.sort((a, b) => {
      const timeA = a.followed_at ? new Date(a.followed_at).getTime() : 0
      const timeB = b.followed_at ? new Date(b.followed_at).getTime() : 0
      return timeB - timeA
    })

    return NextResponse.json({ 
      items,
      count: items.length,
      traderCount: traderFollows.length,
      userCount: userFollows.length
    })
  } catch (error) {
    console.error('[Following API] Error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
