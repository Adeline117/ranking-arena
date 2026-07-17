/**
 * GET /api/feed/activities
 *
 * Public feed of auto-generated trader activity events.
 *
 * Query params:
 *   limit    - max items to return (default 50, max 100)
 *   platform - filter by exchange source (e.g. "binance_futures")
 *   cursor   - ISO timestamp for cursor-based pagination (activities older than this)
 *   handle   - filter to a specific trader handle (for trader profile timeline)
 *
 * @module app/api/feed/activities
 */

export const dynamic = 'force-dynamic'

import { NextRequest } from 'next/server'
import {
  getSupabaseAdmin,
  getAuthUser,
  success,
  handleError,
  validateNumber,
  checkRateLimit,
  RateLimitPresets,
} from '@/lib/api'

const ACTIVITY_SELECT =
  'id, source, source_trader_id, handle, avatar_url, activity_type, activity_text, metric_value, metric_label, occurred_at'
const MAX_FOLLOWED_SOURCES = 50

const PRIVATE_NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
}

type ActivityRow = {
  id: string
  source: string
  source_trader_id: string
  handle: string | null
  avatar_url: string | null
  activity_type: string
  activity_text: string
  metric_value: number | null
  metric_label: string | null
  occurred_at: string
}

function followedIdentity(source: string, traderId: string): string {
  return `${source}:${traderId}`
}

async function readFollowedActivities(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  followedBySource: Map<string, Set<string>>,
  options: {
    limit: number
    platform: string | null
    handle: string | null
    cursor: string | null
  }
): Promise<ActivityRow[]> {
  const sources = options.platform
    ? followedBySource.has(options.platform)
      ? [options.platform]
      : []
    : [...followedBySource.keys()]

  const sourceResults = await Promise.all(
    sources.map(async (source) => {
      const traderIds = [...(followedBySource.get(source) ?? [])]
      let query = supabase
        .from('trader_activities')
        .select(ACTIVITY_SELECT)
        .eq('source', source)
        .in('source_trader_id', traderIds)
        .order('occurred_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(options.limit + 1)

      if (options.handle) query = query.eq('handle', options.handle)
      if (options.cursor) query = query.lt('occurred_at', options.cursor)

      return {
        source,
        allowedIdentities: new Set(traderIds.map((traderId) => followedIdentity(source, traderId))),
        result: await query,
      }
    })
  )

  const activities: ActivityRow[] = []
  for (const { source, allowedIdentities, result } of sourceResults) {
    if (result.error) throw result.error
    for (const activity of result.data ?? []) {
      // Keep the composite check at the release boundary even though each DB
      // query is already source-scoped. A test double or future query rewrite
      // must not be able to widen a user's followed identities.
      if (
        activity.source !== source ||
        !allowedIdentities.has(followedIdentity(activity.source, activity.source_trader_id))
      ) {
        continue
      }
      activities.push(activity)
    }
  }

  activities.sort((left, right) => {
    const occurredDifference = Date.parse(right.occurred_at) - Date.parse(left.occurred_at)
    return occurredDifference || right.id.localeCompare(left.id)
  })
  return activities.slice(0, options.limit + 1)
}

export async function GET(request: NextRequest) {
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.public)
  if (rateLimitResponse) return rateLimitResponse

  try {
    const supabase = getSupabaseAdmin()
    const { searchParams } = new URL(request.url)

    const limit = validateNumber(searchParams.get('limit'), { min: 1, max: 100 }) ?? 50
    const platform = searchParams.get('platform') ?? null
    const cursor = searchParams.get('cursor') ?? null
    const handle = searchParams.get('handle') ?? null
    // `following=1` restricts the feed to the traders the authenticated user
    // follows (trader_follows.trader_id === trader_activities.source_trader_id,
    // same join broadcast-trader-events uses). Guests / users with no follows
    // get an empty result so the client can fall back to Discover.
    const followingOnly =
      searchParams.get('following') === '1' || searchParams.get('following') === 'true'

    let followedBySource: Map<string, Set<string>> | null = null
    if (followingOnly) {
      const user = await getAuthUser(request)
      if (!user) {
        return success(
          { activities: [], pagination: { limit, hasMore: false, nextCursor: null } },
          200,
          PRIVATE_NO_STORE_HEADERS
        )
      }
      const { data: follows, error: followErr } = await supabase
        .from('trader_follows')
        .select('trader_id, source')
        .eq('user_id', user.id)
        .limit(500)
      if (followErr) {
        return handleError(followErr)
      }
      followedBySource = new Map()
      for (const follow of follows ?? []) {
        if (
          typeof follow.source !== 'string' ||
          !follow.source ||
          typeof follow.trader_id !== 'string' ||
          !follow.trader_id
        ) {
          continue
        }
        const ids = followedBySource.get(follow.source) ?? new Set<string>()
        ids.add(follow.trader_id)
        followedBySource.set(follow.source, ids)
      }
      if (followedBySource.size > MAX_FOLLOWED_SOURCES) {
        throw new Error('Following activity source set exceeds the bounded query window')
      }
      if (followedBySource.size === 0) {
        return success(
          { activities: [], pagination: { limit, hasMore: false, nextCursor: null } },
          200,
          PRIVATE_NO_STORE_HEADERS
        )
      }
    }

    let data: ActivityRow[] | null
    let error: { code?: string; message?: string } | null = null
    if (followedBySource) {
      data = await readFollowedActivities(supabase, followedBySource, {
        limit,
        platform,
        handle,
        cursor,
      })
    } else {
      let query = supabase
        .from('trader_activities')
        .select(ACTIVITY_SELECT)
        .order('occurred_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(limit + 1) // fetch one extra to determine hasMore

      if (platform) query = query.eq('source', platform)
      if (handle) query = query.eq('handle', handle)
      if (cursor) query = query.lt('occurred_at', cursor)

      const result = await query
      data = result.data
      error = result.error
    }

    if (error) {
      // Table may not exist yet — return empty feed gracefully
      const isMissingTable =
        (error as { code?: string }).code === '42P01' ||
        (error as { code?: string }).code === 'PGRST200' ||
        error.message?.includes('does not exist') ||
        error.message?.includes('Could not find')
      if (isMissingTable) {
        return success({ activities: [], pagination: { limit, hasMore: false, nextCursor: null } })
      }
      return handleError(error)
    }

    const items = data ?? []
    const hasMore = items.length > limit
    const page = hasMore ? items.slice(0, limit) : items
    const nextCursor = hasMore && page.length > 0 ? page[page.length - 1].occurred_at : null

    // The `following=1` path is per-user (scoped to the caller's follows) and MUST
    // NOT be shared-cached. The default (no `following`) path is identical public
    // data to /api/feed, so it gets the same brief edge cache.
    const cacheHeaders = followingOnly
      ? PRIVATE_NO_STORE_HEADERS
      : { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300' }

    return success(
      {
        activities: page,
        pagination: {
          limit,
          hasMore,
          nextCursor,
        },
      },
      200,
      cacheHeaders
    )
  } catch (err) {
    return handleError(err)
  }
}
