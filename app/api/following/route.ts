/**
 * 获取用户关注列表 API（统一返回交易员和用户）
 *
 * SECURITY: Requires authentication and verifies userId matches authenticated user.
 * This prevents users from accessing other users' private following lists.
 *
 * Optimizations:
 * - Uses leaderboard_ranks as unified data source for trader performance data
 * - Redis cache with 60s TTL via tiered cache
 * - Pagination support via limit/offset params
 */

import { NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger, fireAndForget } from '@/lib/utils/logger'
import { safeParseInt } from '@/lib/utils/safe-parse'
import { withAuth } from '@/lib/api/middleware'
import { tieredGet, tieredSet, tieredDel } from '@/lib/cache/redis-layer'
import { features } from '@/lib/features'

export const dynamic = 'force-dynamic'

const logger = createLogger('following-api')

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
    // Intentionally swallowed: cache invalidation is best-effort, stale following data is acceptable
  }
}

type FollowingResult = { items: FollowItem[]; traderCount: number; userCount: number }

async function fetchFollowingItems(userId: string): Promise<FollowingResult> {
  const supabase = getSupabaseAdmin() as SupabaseClient

  const QUERY_TIMEOUT_MS = 5000

  // 并行获取关注的交易员和用户 (with 5s timeout + limit 500)
  const [traderFollowsResult, userFollowsResult] = await Promise.race([
    Promise.all([
      supabase
        .from('trader_follows')
        .select('trader_id, source, created_at')
        .eq('user_id', userId)
        .limit(500),
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
        .limit(500)
    ]),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Following queries timed out after 5s')), QUERY_TIMEOUT_MS)
    ),
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

    // Use leaderboard_ranks as the single source of truth (unified data layer)
    // instead of separate trader_snapshots v1 + trader_sources + leaderboard_ranks queries.
    // leaderboard_ranks already has handle, avatar_url, roi, pnl, win_rate, followers, arena_score.
    const { data: lrData } = await supabase
      .from('leaderboard_ranks')
      .select('source_trader_id, handle, source, avatar_url, roi, pnl, win_rate, followers, arena_score, rank')
      .in('source_trader_id', traderIds)
      .eq('season_id', '90D')
      .not('arena_score', 'is', null)

    // Build map: best arena_score row per trader
    const traderDataMap = new Map<string, {
      handle: string; source: string; avatar_url?: string
      roi: number; pnl?: number; win_rate: number; followers: number; arena_score?: number
    }>()

    for (const row of (lrData || [])) {
      const existing = traderDataMap.get(row.source_trader_id)
      if (!existing || (row.arena_score || 0) > (existing.arena_score || 0)) {
        traderDataMap.set(row.source_trader_id, {
          handle: row.handle || row.source_trader_id,
          source: row.source,
          avatar_url: row.avatar_url || undefined,
          roi: row.roi ?? 0,
          pnl: row.pnl ?? undefined,
          win_rate: row.win_rate ?? 0,
          followers: row.followers ?? 0,
          arena_score: row.arena_score ?? undefined,
        })
      }
    }

    // 添加交易员到列表
    for (const traderId of traderIds) {
      const data = traderDataMap.get(traderId)

      if (!data) {
        logger.warn(`Trader not found in leaderboard_ranks: ${traderId}`)
        continue
      }

      items.push({
        id: traderId,
        handle: data.handle || traderId,
        type: 'trader',
        avatar_url: data.avatar_url,
        roi: data.roi,
        pnl: data.pnl,
        win_rate: data.win_rate,
        followers: data.followers,
        source: data.source || 'binance_futures',
        arena_score: data.arena_score,
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

export const GET = withAuth(async ({ user: authUser, request }) => {
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

  let { items, userCount } = result
  const { traderCount } = result

  // When social features are off, filter to trader items only
  if (!features.social) {
    items = items.filter(item => item.type === 'trader')
    userCount = 0
  }

  // Apply pagination if limit is provided
  const limit = limitParam ? Math.min(Math.max(safeParseInt(limitParam, 50), 1), 200) : undefined
  const offset = offsetParam ? Math.max(safeParseInt(offsetParam, 0), 0) : 0

  const paginatedItems = limit !== undefined ? items.slice(offset, offset + limit) : items

  return NextResponse.json({
    items: paginatedItems,
    count: items.length,
    traderCount,
    userCount,
    ...(limit !== undefined ? { limit, offset, hasMore: offset + limit < items.length } : {})
  })
}, { name: 'get-following', rateLimit: 'authenticated' })
