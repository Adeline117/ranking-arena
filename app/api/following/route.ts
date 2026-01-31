/**
 * 获取用户关注列表 API（统一返回交易员和用户）
 *
 * SECURITY: Requires authentication and verifies userId matches authenticated user.
 * This prevents users from accessing other users' private following lists.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/utils/logger'
import { getAuthUser } from '@/lib/supabase/server'
import { ALL_SOURCES } from '@/lib/constants/exchanges'

export const dynamic = 'force-dynamic'

const logger = createLogger('following-api')

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ''

// 统一的关注项类型
type FollowItem = {
  id: string
  handle: string
  type: 'trader' | 'user'
  avatar_url?: string
  bio?: string
  // 交易员特有字段
  roi?: number
  roi_7d?: number
  roi_30d?: number
  pnl?: number
  win_rate?: number
  followers?: number
  source?: string
  arena_score?: number
  // 排序用
  followed_at?: string
}

export async function GET(request: NextRequest) {
  try {
    // SECURITY: Require authentication
    const authUser = await getAuthUser(request)
    if (!authUser) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
    }

    const userId = request.nextUrl.searchParams.get('userId')

    if (!userId) {
      return NextResponse.json({ error: 'Missing userId' }, { status: 400 })
    }

    // SECURITY: Verify that userId matches authenticated user
    // This prevents users from accessing other users' following lists
    if (userId !== authUser.id) {
      logger.warn('User attempted to access another user\'s following list', {
        authUserId: authUser.id,
        requestedUserId: userId
      })
      return NextResponse.json({ error: 'Unauthorized: Cannot access other users\' following lists' }, { status: 403 })
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
      // Supabase 返回的 following 可能是单个对象或数组，需要处理
      const following = follow.following
      const user = Array.isArray(following) ? following[0] : following
      if (user && typeof user === 'object' && 'id' in user) {
        const userObj = user as { id: string; handle?: string; bio?: string; avatar_url?: string }
        items.push({
          id: userObj.id,
          handle: userObj.handle || '未命名用户',
          type: 'user',
          avatar_url: userObj.avatar_url,
          bio: userObj.bio,
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
          .select('source_trader_id, handle, source, avatar_url, arena_score')
          .in('source_trader_id', traderIds),
        supabase
          .from('trader_snapshots')
          .select('source_trader_id, source, rank, roi, roi_7d, roi_30d, followers, pnl, win_rate, arena_score, captured_at')
          .in('source_trader_id', traderIds)
          .in('source', ALL_SOURCES)
          .order('captured_at', { ascending: false })
          .limit(5000)
      ])

      const sources = sourcesResult.data || []
      const allSnapshots = snapshotsResult.data || []

      // 构建映射
      const sourcesMap = new Map<string, { handle: string; source: string; avatar_url?: string; arena_score?: number }>()
      sources.forEach((s: { source_trader_id: string; handle: string | null; source: string; avatar_url?: string | null; arena_score?: number | null }) => {
        sourcesMap.set(s.source_trader_id, {
          handle: s.handle || s.source_trader_id,
          source: s.source,
          avatar_url: s.avatar_url || undefined,
          arena_score: s.arena_score ?? undefined
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
          logger.warn(`Trader not found in trader_sources or trader_snapshots: ${traderId}`)
          continue
        }
        
        items.push({
          id: traderId,
          handle: sourceInfo?.handle || traderId,
          type: 'trader',
          avatar_url: sourceInfo?.avatar_url,
          roi: snapshot?.roi || 0,
          roi_7d: snapshot?.roi_7d ?? undefined,
          roi_30d: snapshot?.roi_30d ?? undefined,
          pnl: snapshot?.pnl !== null && snapshot?.pnl !== undefined ? snapshot.pnl : undefined,
          win_rate: snapshot?.win_rate !== null && snapshot?.win_rate !== undefined ? snapshot.win_rate : 0,
          followers: snapshot?.followers || 0,
          source: snapshot?.source || sourceInfo?.source || 'binance_futures',
          arena_score: snapshot?.arena_score ?? sourceInfo?.arena_score ?? undefined,
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
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    logger.error('Following API error', { error: errorMessage })
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
