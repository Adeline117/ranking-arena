/**
 * 获取用户关注列表 API（统一返回交易员和用户）
 *
 * SECURITY: Requires authentication and verifies userId matches authenticated user.
 * This prevents users from accessing other users' private following lists.
 *
 * Optimizations:
 * - Batched queries (sources + snapshots + leaderboard_ranks in single Promise.all)
 * - Redis cache with 60s TTL via tiered cache
 * - Pagination support via limit/offset params
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { createLogger, fireAndForget } from '@/lib/utils/logger'
import { getAuthUser } from '@/lib/supabase/server'
import { tieredGet, tieredSet, tieredDel } from '@/lib/cache/redis-layer'
import { features } from '@/lib/features'

export const dynamic = 'force-dynamic'

const logger = createLogger('following-api')

function getSupabaseUrl() {
  return process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
}
function getSupabaseKey() {
  return process.env.SUPABASE_SERVICE_ROLE_KEY || ''
}

function followingCacheKey(userId: string): string {
  return `following:${userId}`
}

// 统一的关注项类型
type FollowItem = {
  id: string
  handle: string
  type: 'trader' | 'user'
  avatar_url?: string
  bio?: string
  roi?: number
  roi_7d?: number
  roi_30d?: number
  pnl?: number
  win_rate?: number
  followers?: number
  source?: string
  arena_score?: number
  followed_at?: string
}

/** Invalidate the following cache for a user. Called from follow/unfollow API. */
export async function invalidateFollowingCache(userId: string): Promise<void> {
  try {
    await tieredDel(followingCacheKey(userId))
  } catch {
    // best-effort
  }
}

type FollowingResult = { items: FollowItem[]; traderCount: number; userCount: number }

async function fetchFollowingItems(userId: string): Promise<FollowingResult> {
  const supabase = createClient(getSupabaseUrl(), getSupabaseKey())

  // 并行获取关注的交易员和用户
  const [traderFollowsResult, userFollowsResult] = await Promise.all([
    supabase
      .from('trader_follows')
      .select('trader_id, source, created_at')
      .eq('user_id', userId),
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

    // Single batched Promise.all: sources + snapshots + leaderboard_ranks
    // Previously leaderboard_ranks was a conditional N+1; now fetched upfront
    const [sourcesResult, snapshotsResult, lrResult] = await Promise.all([
      supabase
        .from('trader_sources')
        .select('source_trader_id, handle, source, avatar_url, arena_score')
        .in('source_trader_id', traderIds),
      supabase
        .from('trader_snapshots')
        .select('source_trader_id, source, rank, roi, pnl_7d, pnl_30d, followers, pnl, win_rate, arena_score, captured_at')
        .in('source_trader_id', traderIds)
        .eq('season_id', '90D')
        .not('arena_score', 'is', null),
      // Pre-fetch leaderboard_ranks for all traders (avoids conditional 4th query)
      supabase
        .from('leaderboard_ranks')
        .select('source_trader_id, display_name, source, avatar_url')
        .in('source_trader_id', traderIds)
        .not('display_name', 'is', null)
        .limit(traderIds.length)
    ])

    const sources = sourcesResult.data || []
    const allSnapshots = snapshotsResult.data || []
    const lrRows = lrResult.data || []

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

    // Apply leaderboard_ranks fallback for missing/matching-id handles
    for (const lr of lrRows) {
      if (!sourcesMap.has(lr.source_trader_id)) {
        sourcesMap.set(lr.source_trader_id, {
          handle: lr.display_name,
          source: lr.source,
          avatar_url: lr.avatar_url || undefined,
        })
      } else {
        const existing = sourcesMap.get(lr.source_trader_id)!
        if (existing.handle === lr.source_trader_id && lr.display_name) {
          existing.handle = lr.display_name
        }
        if (!existing.avatar_url && lr.avatar_url) {
          existing.avatar_url = lr.avatar_url
        }
      }
    }

    // Build map: one snapshot per trader (best arena_score)
    const latestSnapshotsMap = new Map<string, typeof allSnapshots[0]>()
    for (const snapshot of allSnapshots) {
      const key = snapshot.source_trader_id
      if (!latestSnapshotsMap.has(key) || (snapshot.arena_score || 0) > (latestSnapshotsMap.get(key)!.arena_score || 0)) {
        latestSnapshotsMap.set(key, snapshot)
      }
    }

    // 添加交易员到列表
    for (const traderId of traderIds) {
      const sourceInfo = sourcesMap.get(traderId)
      const snapshot = latestSnapshotsMap.get(traderId)
      
      if (!sourceInfo && !snapshot) {
        logger.warn(`Trader not found in trader_sources or trader_snapshots: ${traderId}`)
        continue
      }
      
      items.push({
        id: traderId,
        handle: sourceInfo?.handle || traderId,
        type: 'trader',
        avatar_url: sourceInfo?.avatar_url,
        roi: snapshot?.roi ?? 0,
        roi_7d: snapshot?.pnl_7d ?? undefined,
        roi_30d: snapshot?.pnl_30d ?? undefined,
        pnl: snapshot?.pnl !== null && snapshot?.pnl !== undefined ? snapshot.pnl : undefined,
        win_rate: snapshot?.win_rate !== null && snapshot?.win_rate !== undefined ? snapshot.win_rate : 0,
        followers: snapshot?.followers ?? 0,
        source: snapshot?.source || sourceInfo?.source || 'binance_futures',
        arena_score: snapshot?.arena_score ?? sourceInfo?.arena_score ?? undefined,
        followed_at: followedAtMap.get(traderId)
      })
    }
  }

  // 按关注时间降序排序
  items.sort((a, b) => {
    const timeA = a.followed_at ? new Date(a.followed_at).getTime() : 0
    const timeB = b.followed_at ? new Date(b.followed_at).getTime() : 0
    return timeB - timeA
  })

  return { items, traderCount: traderFollows.length, userCount: userFollows.length }
}

export async function GET(request: NextRequest) {
  try {
    // SECURITY: Require authentication
    const authUser = await getAuthUser(request)
    if (!authUser) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
    }

    const userId = request.nextUrl.searchParams.get('userId')
    const limitParam = request.nextUrl.searchParams.get('limit')
    const offsetParam = request.nextUrl.searchParams.get('offset')

    if (!userId) {
      return NextResponse.json({ error: 'Missing userId' }, { status: 400 })
    }

    // SECURITY: Verify that userId matches authenticated user
    if (userId !== authUser.id) {
      logger.warn('User attempted to access another user\'s following list', {
        authUserId: authUser.id,
        requestedUserId: userId
      })
      return NextResponse.json({ error: 'Unauthorized: Cannot access other users\' following lists' }, { status: 403 })
    }

    if (!getSupabaseUrl() || !getSupabaseKey()) {
      return NextResponse.json({ error: 'Missing Supabase config' }, { status: 500 })
    }

    // Try cache first (hot tier: 1min memory, 5min redis)
    const cacheKey = followingCacheKey(userId)
    const cached = await tieredGet<FollowingResult>(cacheKey, 'hot')

    let result: FollowingResult
    if (cached.data) {
      result = cached.data
    } else {
      result = await fetchFollowingItems(userId)
      fireAndForget(tieredSet(cacheKey, result, 'hot', ['following']), 'Cache following list')
    }

    let { items, traderCount, userCount } = result

    // When social features are off, filter to trader items only
    if (!features.social) {
      items = items.filter(item => item.type === 'trader')
      userCount = 0
    }

    // Apply pagination if limit is provided
    const limit = limitParam ? Math.min(Math.max(parseInt(limitParam, 10) || 50, 1), 200) : undefined
    const offset = offsetParam ? Math.max(parseInt(offsetParam, 10) || 0, 0) : 0

    const paginatedItems = limit !== undefined ? items.slice(offset, offset + limit) : items

    return NextResponse.json({ 
      items: paginatedItems,
      count: items.length,
      traderCount,
      userCount,
      ...(limit !== undefined ? { limit, offset, hasMore: offset + limit < items.length } : {})
    })
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    logger.error('Following API error', { error: errorMessage })
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
