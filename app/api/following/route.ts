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
  return `following:v4:candidates:${userId}`
}

const FOLLOW_EDGE_PAGE_SIZE = 500
const MATERIALIZATION_CHUNK_SIZE = 100
const MATERIALIZATION_CONCURRENCY = 3
const QUERY_TIMEOUT_MS = 15000

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
      tieredDel(`following:v3:candidates:${userId}`),
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

type TraderFollowRow = {
  id: string
  trader_id: string
  source: string | null
  created_at: string | null
}

type UserFollowRow = {
  id: string
  following_id: string
  created_at: string | null
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

async function fetchAllPages<Row>(
  loadPage: (from: number, to: number) => Promise<{ data: Row[] | null; error: unknown }>
): Promise<Row[]> {
  const rows: Row[] = []

  for (let from = 0; ; from += FOLLOW_EDGE_PAGE_SIZE) {
    const { data, error } = await loadPage(from, from + FOLLOW_EDGE_PAGE_SIZE - 1)
    if (error) throw error
    if (!Array.isArray(data)) {
      throw new Error('Following query returned no page data')
    }

    rows.push(...data)
    if (data.length < FOLLOW_EDGE_PAGE_SIZE) return rows
  }
}

async function mapWithConcurrency<Input, Output>(
  inputs: Input[],
  concurrency: number,
  worker: (input: Input) => Promise<Output>
): Promise<Output[]> {
  if (inputs.length === 0) return []

  const outputs = new Array<Output>(inputs.length)
  let nextIndex = 0
  let stopped = false

  const consume = async () => {
    while (!stopped) {
      const index = nextIndex
      if (index >= inputs.length) return
      nextIndex += 1

      try {
        outputs[index] = await worker(inputs[index])
      } catch (error) {
        // Do not launch more chunks after the first failure. Requests already
        // in flight may finish, but the caller receives no partial result.
        stopped = true
        throw error
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, inputs.length) }, () => consume()))
  return outputs
}

async function fetchRowsInChunks<Row>(
  ids: string[],
  label: string,
  loadChunk: (ids: string[]) => Promise<{ data: Row[] | null; error: unknown }>
): Promise<Row[]> {
  const chunks: string[][] = []
  for (let index = 0; index < ids.length; index += MATERIALIZATION_CHUNK_SIZE) {
    chunks.push(ids.slice(index, index + MATERIALIZATION_CHUNK_SIZE))
  }

  const chunkRows = await mapWithConcurrency(chunks, MATERIALIZATION_CONCURRENCY, async (chunk) => {
    const { data, error } = await loadChunk(chunk)
    if (error) throw error
    if (!Array.isArray(data)) {
      throw new Error(`${label} materialization returned no chunk data`)
    }
    return data
  })

  return chunkRows.flat()
}

async function fetchFollowingCandidates(userId: string): Promise<FollowingCandidates> {
  const supabase = getSupabaseAdmin()

  // Each edge type is read page-by-page with a unique tie-breaker. The two
  // independent scans run together, but a failure in either scan rejects the
  // whole candidate load so a partial list is never cached or returned.
  const [traderFollows, userFollows] = await Promise.all([
    fetchAllPages<TraderFollowRow>(async (from, to) =>
      supabase
        .from('trader_follows')
        .select('id, trader_id, source, created_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: false, nullsFirst: false })
        .order('id', { ascending: false })
        .range(from, to)
        .abortSignal(AbortSignal.timeout(QUERY_TIMEOUT_MS))
    ),
    // NOTE: user_follows.following_id references auth.users (not
    // public.user_profiles), so a PostgREST embed fails with PGRST200.
    // Two-step query: fetch follow rows here, then look up profiles below.
    fetchAllPages<UserFollowRow>(async (from, to) =>
      supabase
        .from('user_follows')
        .select('id, created_at, following_id')
        .eq('follower_id', userId)
        .order('created_at', { ascending: false, nullsFirst: false })
        .order('id', { ascending: false })
        .range(from, to)
        .abortSignal(AbortSignal.timeout(QUERY_TIMEOUT_MS))
    ),
  ])

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
  const followingProfiles = await fetchRowsInChunks(followingIds, 'user_profiles', async (chunk) =>
    supabase
      .from('user_profiles')
      .select('id, handle, bio, avatar_url, deleted_at, banned_at, is_banned, ban_expires_at')
      .in('id', chunk)
      .abortSignal(AbortSignal.timeout(QUERY_TIMEOUT_MS))
  )

  const now = Date.now()
  const userProfileById = new Map(
    followingProfiles
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
    const lrData = await fetchRowsInChunks(traderIds, 'leaderboard_ranks', async (chunk) =>
      supabase
        .from('leaderboard_ranks')
        .select(
          'source_trader_id, handle, source, avatar_url, roi, pnl, win_rate, followers, arena_score, rank'
        )
        .in('source_trader_id', chunk)
        .eq('season_id', '90D')
        .gt('arena_score', 0)
        .or('is_outlier.is.null,is_outlier.eq.false')
        .abortSignal(AbortSignal.timeout(QUERY_TIMEOUT_MS))
    )

    // A trader identity is composite. Matching only source_trader_id can attach
    // another exchange's handle and performance when platforms reuse an ID.
    const traderDataMap = new Map<string, TraderMaterializedData>()
    const traderRowsByRawId = new Map<string, TraderMaterializedData[]>()

    for (const row of lrData) {
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

  // 按关注时间降序排序，并以稳定边身份打破相同/无效时间戳的平局。
  items.sort((a, b) => {
    const parsedTimeA = a.followed_at ? Date.parse(a.followed_at) : 0
    const parsedTimeB = b.followed_at ? Date.parse(b.followed_at) : 0
    const timeA = Number.isFinite(parsedTimeA) ? parsedTimeA : 0
    const timeB = Number.isFinite(parsedTimeB) ? parsedTimeB : 0
    if (timeA !== timeB) return timeB - timeA
    if (a.identity_key < b.identity_key) return -1
    if (a.identity_key > b.identity_key) return 1
    return 0
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
