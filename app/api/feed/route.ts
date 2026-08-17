/**
 * GET /api/feed
 *
 * Public feed of auto-generated trader activity events.
 * Duplicates /api/feed/activities logic directly to avoid unreliable
 * self-referential HTTP fetch in serverless environments.
 *
 * Query params:
 *   limit    - max items to return (default 50, max 100)
 *   platform - filter by exchange source (e.g. "binance_futures")
 *   cursor   - ISO timestamp for cursor-based pagination (activities older than this)
 *   handle   - filter to a specific trader handle (for trader profile timeline)
 */

import { NextRequest } from 'next/server'
import {
  getSupabaseAdmin,
  success,
  handleError,
  validateNumber,
  checkRateLimit,
  RateLimitPresets,
} from '@/lib/api'
import { createLogger } from '@/lib/utils/logger'
import {
  filterPublicNonRankingActivities,
  hasPublicNonRankingActivityTypes,
  noStorePublicActivity,
  PUBLIC_NON_RANKING_ACTIVITY_TYPES,
  unavailablePublicActivityFeed,
} from '@/lib/feed/public-activity-policy'

const log = createLogger('api:feed')

// Legacy ranking activity rows have no event-time public proof. Never cache a
// response that could outlive a publication-boundary change.
export const dynamic = 'force-dynamic'
export const revalidate = 0

export async function GET(request: NextRequest) {
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.public)
  if (rateLimitResponse) return noStorePublicActivity(rateLimitResponse)

  try {
    const { searchParams } = new URL(request.url)

    const limit = validateNumber(searchParams.get('limit'), { min: 1, max: 100 }) ?? 50
    const platform = searchParams.get('platform') ?? null
    const cursor = searchParams.get('cursor') ?? null
    const handle = searchParams.get('handle') ?? null

    // No legacy activity type carries an event-time publication receipt. Do
    // not issue an empty `.in()` query (or read the table at all) and risk a
    // future query widening publishing historical free-form claims.
    if (!hasPublicNonRankingActivityTypes()) {
      return noStorePublicActivity(success(unavailablePublicActivityFeed(limit)))
    }

    const supabase = getSupabaseAdmin()

    let query = supabase
      .from('trader_activities')
      .select(
        'id, source, source_trader_id, handle, avatar_url, activity_type, activity_text, metric_value, metric_label, occurred_at'
      )
      .in('activity_type', PUBLIC_NON_RANKING_ACTIVITY_TYPES)
      .order('occurred_at', { ascending: false })
      .limit(limit + 1) // fetch one extra to determine hasMore

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
      const errCode = (error as { code?: string }).code
      const errMsg = error.message ?? ''
      const isMissingTable =
        errCode === '42P01' ||
        errCode === 'PGRST200' ||
        errMsg.includes('does not exist') ||
        errMsg.includes('Could not find') ||
        errMsg.includes('relation') ||
        errMsg.includes('schema cache')
      if (isMissingTable) {
        return noStorePublicActivity(
          success({ activities: [], pagination: { limit, hasMore: false, nextCursor: null } })
        )
      }
      log.error('Supabase error', { code: errCode, message: errMsg })
      return noStorePublicActivity(handleError(error))
    }

    const items = filterPublicNonRankingActivities(data ?? [])
    const hasMore = items.length > limit
    const page = hasMore ? items.slice(0, limit) : items
    const nextCursor = hasMore && page.length > 0 ? page[page.length - 1].occurred_at : null

    return noStorePublicActivity(
      success({
        activities: page,
        pagination: {
          limit,
          hasMore,
          nextCursor,
        },
      })
    )
  } catch (err) {
    return noStorePublicActivity(handleError(err))
  }
}
