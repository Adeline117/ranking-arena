/**
 * GET /api/traders/aggregate?user_id=xxx or ?handle=xxx
 *
 * Returns aggregated stats across all linked trader accounts for a user.
 * Public endpoint — used by trader profile pages to show multi-account data.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin, handleError, checkRateLimit, RateLimitPresets } from '@/lib/api'
import { getAggregatedStats, findUserByTrader } from '@/lib/data/linked-traders'
import { tieredGetOrSet } from '@/lib/cache/redis-layer'

// Shape is inferred from buildResponse so we don't duplicate getAggregatedStats's types.
type AggregatedResponse = Awaited<ReturnType<typeof buildResponse>>

async function buildResponse(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  userId: string,
) {
  const stats = await getAggregatedStats(supabase, userId)
  if (!stats) {
    return {
      aggregated: null,
      accounts: [] as NonNullable<Awaited<ReturnType<typeof getAggregatedStats>>>['accounts'],
      totalAccounts: 0,
    }
  }
  return {
    aggregated: {
      combinedPnl: stats.combinedPnl,
      bestRoi: stats.bestRoi,
      weightedScore: stats.weightedScore,
    },
    accounts: stats.accounts,
    totalAccounts: stats.totalAccounts,
  }
}

const EMPTY_RESPONSE: AggregatedResponse = {
  aggregated: null,
  accounts: [],
  totalAccounts: 0,
}

// Cache headers: edge CDN 5min + SWR 10min. Data only changes when a user
// links/unlinks a trader account (rare) or trader snapshots refresh (~5min).
const CACHE_HEADERS = {
  'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600',
}

export async function GET(request: NextRequest) {
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.read)
  if (rateLimitResponse) return rateLimitResponse

  try {
    const { searchParams } = new URL(request.url)
    let userId = searchParams.get('user_id')
    const handle = searchParams.get('handle')
    const platform = searchParams.get('platform')
    const traderKey = searchParams.get('trader_key')

    const supabase = getSupabaseAdmin()

    // Resolve user_id from handle if not provided directly
    if (!userId && handle) {
      const { data: profile } = await supabase
        .from('user_profiles')
        .select('id')
        .eq('handle', handle)
        .maybeSingle()

      if (profile?.id) {
        userId = String(profile.id)
      }
    }

    // Resolve user_id from trader platform+key
    if (!userId && platform && traderKey) {
      userId = await findUserByTrader(supabase, platform, traderKey)
    }

    if (!userId) {
      return NextResponse.json(
        { success: true, data: EMPTY_RESPONSE },
        { headers: CACHE_HEADERS },
      )
    }

    // Redis-cached: stampede-protected, warm tier (15min Redis, 2min memory)
    const cacheKey = `aggregate:user:${userId}`
    const data = await tieredGetOrSet<AggregatedResponse>(
      cacheKey,
      () => buildResponse(supabase, userId!),
      'warm',
      ['aggregate', `user:${userId}`],
    )

    return NextResponse.json(
      { success: true, data },
      { headers: CACHE_HEADERS },
    )
  } catch (error: unknown) {
    return handleError(error, 'traders/aggregate GET')
  }
}
