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
import { createLogger, fireAndForget } from '@/lib/utils/logger'
import { safeParseInt } from '@/lib/utils/safe-parse'
import { withAuth } from '@/lib/api/middleware'
import { tieredGet, tieredSet, tieredDel } from '@/lib/cache/redis-layer'
import { features } from '@/lib/features'
import { isPublicProfileActive } from '@/lib/profile/public-audience'

export const dynamic = 'force-dynamic'

const logger = createLogger('following-api')

function followingCandidateCacheKey(userId: string): string {
  return `following:v3:candidates:${userId}`
}

// 统一的关注项类型
type FollowItem = {
  id: string
  /** Stable edge identity. Unlike id, this never collides across exchanges. */
  identity_key: string
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
  /** Stored follow source. Null is reserved for a pre-composite legacy edge. */
  source?: string | null
  /** Resolved profile platform used for navigation; absent for unresolved legacy edges. */
  platform?: string
  arena_score?: number
  followed_at?: string
}

/** Invalidate the following cache for a user. Called from follow/unfollow API. */
export async function invalidateFollowingCache(userId: string): Promise<void> {
  try {
    await Promise.all([
      tieredDel(followingCandidateCacheKey(userId)),
      tieredDel(`following:v2:candidates:${userId}`),
      // Remove payloads written by older route versions as well. Pre-v2
      // payloads contained mutable profile fields, while v2 omitted legacy
      // null-source edges.
      tieredDel(`following:${userId}`),
    ])
  } catch {
    // Mutation routes still succeed if Redis is unavailable. The v3 cache has
    // a distinct namespace, and every candidate is re-materialized below.
  }
}

type TraderFollowCandidate = {
  traderId: string
  source: string | null
  followedAt?: string
}

type UserFollowCandidate = {
  userId: string
  followedAt?: string
}

type FollowingCandidates = {
  traders: TraderFollowCandidate[]
  users: UserFollowCandidate[]
}

type FollowingResult = { items: FollowItem[]; traderCount: number; userCount: number }

type TraderMaterializedData = {
  handle: string
  source: string
  avatar_url?: string
  roi: number
  pnl?: number
  win_rate: number
  followers: number
  arena_score?: number
}

async function fetchFollowingCandidates(userId: string): Promise<FollowingCandidates> {
  const supabase = getSupabaseAdmin()

  const QUERY_TIMEOUT_MS = 15000

  // Abort the underlying PostgREST requests as well as bounding the handler.
  // A Promise.race timeout alone leaves both network requests running.
  const [traderFollowsResult, userFollowsResult] = await Promise.all([
    supabase
      .from('trader_follows')
      .select('trader_id, source, created_at')
      .eq('user_id', userId)
      .limit(500)
      .abortSignal(AbortSignal.timeout(QUERY_TIMEOUT_MS)),
    // NOTE: user_follows.following_id references auth.users (not
    // public.user_profiles), so a PostgREST embed fails with PGRST200.
    // Two-step query: fetch follow rows here, then look up profiles below.
    supabase
      .from('user_follows')
      .select('created_at, following_id')
      .eq('follower_id', userId)
      .limit(500)
      .abortSignal(AbortSignal.timeout(QUERY_TIMEOUT_MS)),
  ])

  const traderFollows = traderFollowsResult.data || []
  const userFollows = userFollowsResult.data || []
  if (traderFollowsResult.error) throw traderFollowsResult.error
  if (userFollowsResult.error) throw userFollowsResult.error

  return {
    traders: traderFollows.flatMap((follow) => {
      if (typeof follow.trader_id !== 'string' || follow.trader_id.length === 0) {
        return []
      }
      const source =
        typeof follow.source === 'string' && follow.source.length > 0 ? follow.source : null
      return [
        {
          traderId: follow.trader_id,
          source,
          followedAt: follow.created_at ?? undefined,
        },
      ]
    }),
    users: userFollows
      .filter((follow) => typeof follow.following_id === 'string' && follow.following_id.length > 0)
      .map((follow) => ({
        userId: follow.following_id,
        followedAt: follow.created_at ?? undefined,
      })),
  }
}

function traderCandidateIdentity(candidate: TraderFollowCandidate): string {
  return `${candidate.source ?? '__legacy_null__'}:${candidate.traderId}`
}

function traderRowIdentity(row: { source: string; source_trader_id: string }): string {
  return `${row.source}:${row.source_trader_id}`
}

function traderFollowItemIdentity(source: string | null, traderId: string): string {
  return source === null ? `trader:legacy-null:${traderId}` : `trader:source:${source}:${traderId}`
}

async function materializeFollowingItems(
  candidates: FollowingCandidates
): Promise<FollowingResult> {
  const supabase = getSupabaseAdmin()
  const items: FollowItem[] = []

  // Redis stores only edge candidates. Mutable account fields and moderation
  // state are read on every request before a service-role row is released.
  const followingIds = [...new Set(candidates.users.map((candidate) => candidate.userId))]
  const { data: followingProfiles, error: followingProfilesError } = followingIds.length
    ? await supabase
        .from('user_profiles')
        .select('id, handle, bio, avatar_url, deleted_at, banned_at, is_banned, ban_expires_at')
        .in('id', followingIds)
        .abortSignal(AbortSignal.timeout(15000))
    : { data: null, error: null }
  if (followingProfilesError) throw followingProfilesError

  const now = Date.now()
  const userProfileById = new Map(
    (followingProfiles || [])
      .filter((profile) => isPublicProfileActive(profile, now))
      .map((profile) => [profile.id, profile])
  )

  for (const candidate of candidates.users) {
    const userObj = userProfileById.get(candidate.userId)
    if (userObj) {
      items.push({
        id: userObj.id,
        identity_key: `user:${userObj.id}`,
        handle: userObj.handle || '未命名用户',
        type: 'user',
        avatar_url: userObj.avatar_url ?? undefined,
        bio: userObj.bio ?? undefined,
        followed_at: candidate.followedAt,
      })
    }
  }

  if (candidates.traders.length > 0) {
    const traderIds = [...new Set(candidates.traders.map((candidate) => candidate.traderId))]
    const { data: lrData, error: lrError } = await supabase
      .from('leaderboard_ranks')
      .select(
        'source_trader_id, handle, source, avatar_url, roi, pnl, win_rate, followers, arena_score, rank'
      )
      .in('source_trader_id', traderIds)
      .eq('season_id', '90D')
      .gt('arena_score', 0)
      .or('is_outlier.is.null,is_outlier.eq.false')
      .abortSignal(AbortSignal.timeout(15000))
    if (lrError) throw lrError

    // A trader identity is composite. Matching only source_trader_id can attach
    // another exchange's handle and performance when platforms reuse an ID.
    const traderDataMap = new Map<string, TraderMaterializedData>()
    const traderRowsByRawId = new Map<string, TraderMaterializedData[]>()

    for (const row of lrData || []) {
      const identity = traderRowIdentity(row)
      if (!traderDataMap.has(identity)) {
        const materialized = {
          handle: row.handle || row.source_trader_id,
          source: row.source,
          avatar_url: row.avatar_url || undefined,
          roi: row.roi ?? 0,
          pnl: row.pnl ?? undefined,
          win_rate: row.win_rate ?? 0,
          followers: row.followers ?? 0,
          arena_score: row.arena_score ?? undefined,
        }
        traderDataMap.set(identity, materialized)
        const rows = traderRowsByRawId.get(row.source_trader_id) || []
        rows.push(materialized)
        traderRowsByRawId.set(row.source_trader_id, rows)
      }
    }

    for (const candidate of candidates.traders) {
      const exactData =
        candidate.source === null
          ? undefined
          : traderDataMap.get(traderCandidateIdentity(candidate))
      const legacyMatches =
        candidate.source === null ? traderRowsByRawId.get(candidate.traderId) || [] : []
      const data = exactData ?? (legacyMatches.length === 1 ? legacyMatches[0] : undefined)

      if (!data && candidate.source !== null) {
        logger.warn(
          `Trader not found in current leaderboard_ranks: ${traderCandidateIdentity(candidate)}`
        )
      }
      if (!data && candidate.source === null) {
        logger.warn(
          `Legacy trader follow has no unambiguous current profile: ${candidate.traderId}`
        )
      }

      items.push({
        id: candidate.traderId,
        identity_key: traderFollowItemIdentity(candidate.source, candidate.traderId),
        handle: data?.handle || candidate.traderId,
        type: 'trader',
        avatar_url: data?.avatar_url,
        roi: data?.roi,
        pnl: data?.pnl,
        win_rate: data?.win_rate,
        followers: data?.followers,
        source: candidate.source,
        platform: candidate.source ?? data?.source,
        arena_score: data?.arena_score,
        followed_at: candidate.followedAt,
      })
    }
  }

  // 按关注时间降序排序
  items.sort((a, b) => {
    const timeA = a.followed_at ? new Date(a.followed_at).getTime() : 0
    const timeB = b.followed_at ? new Date(b.followed_at).getTime() : 0
    return timeB - timeA
  })

  return {
    items,
    traderCount: items.filter((item) => item.type === 'trader').length,
    userCount: items.filter((item) => item.type === 'user').length,
  }
}

export const GET = withAuth(
  async ({ user: authUser, request }) => {
    const userId = request.nextUrl.searchParams.get('userId')
    const limitParam = request.nextUrl.searchParams.get('limit')
    const offsetParam = request.nextUrl.searchParams.get('offset')

    if (!userId) {
      return NextResponse.json({ error: 'Missing userId' }, { status: 400 })
    }

    // SECURITY: Verify that userId matches authenticated user
    if (userId !== authUser.id) {
      logger.warn("User attempted to access another user's following list", {
        authUserId: authUser.id,
        requestedUserId: userId,
      })
      return NextResponse.json(
        { error: "Unauthorized: Cannot access other users' following lists" },
        { status: 403 }
      )
    }

    // Try cache first (hot tier: 1min memory, 5min redis)
    const cacheKey = followingCandidateCacheKey(userId)
    const cached = await tieredGet<FollowingCandidates>(cacheKey, 'hot')

    let candidates: FollowingCandidates
    if (cached.data) {
      candidates = cached.data
    } else {
      candidates = await fetchFollowingCandidates(userId)
      fireAndForget(
        tieredSet(cacheKey, candidates, 'hot', ['following']),
        'Cache following candidates'
      )
    }

    const result = await materializeFollowingItems(candidates)

    let { items, userCount } = result
    const { traderCount } = result

    // When social features are off, filter to trader items only
    if (!features.social) {
      items = items.filter((item) => item.type === 'trader')
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
      ...(limit !== undefined ? { limit, offset, hasMore: offset + limit < items.length } : {}),
    })
  },
  { name: 'get-following', rateLimit: 'authenticated' }
)
