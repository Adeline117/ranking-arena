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

    let followedTraderIds: string[] | null = null
    if (followingOnly) {
      const user = await getAuthUser(request)
      if (!user) {
        return success({ activities: [], pagination: { limit, hasMore: false, nextCursor: null } })
      }
      const { data: follows, error: followErr } = await supabase
        .from('trader_follows')
        .select('trader_id')
        .eq('user_id', user.id)
      if (followErr) {
        return handleError(followErr)
      }
      followedTraderIds = [...new Set((follows ?? []).map((f) => f.trader_id).filter(Boolean))]
      if (followedTraderIds.length === 0) {
        return success({ activities: [], pagination: { limit, hasMore: false, nextCursor: null } })
      }
    }

    let query = supabase
      .from('trader_activities')
      .select(
        'id, source, source_trader_id, handle, avatar_url, activity_type, activity_text, metric_value, metric_label, occurred_at'
      )
      .order('occurred_at', { ascending: false })
      .limit(limit + 1) // fetch one extra to determine hasMore

    if (followedTraderIds) {
      query = query.in('source_trader_id', followedTraderIds)
    }

    if (platform) {
      query = query.eq('source', platform)
    }

    if (handle) {
      query = query.eq('handle', handle)
    }

    if (cursor) {
      // Return items strictly older than the cursor timestamp
      query = query.lt('occurred_at', cursor)
    }

    const { data, error } = await query

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
      ? undefined
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
