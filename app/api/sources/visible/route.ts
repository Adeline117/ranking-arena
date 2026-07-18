/** GET /api/sources/visible?timeRange=7D|30D|90D */

import type { NextRequest } from 'next/server'
import { ApiError } from '@/lib/api/errors'
import { withPublic } from '@/lib/api/middleware'
import { success as apiSuccess, withCache } from '@/lib/api/response'
import {
  parseVisibleLeaderboardSources,
  type LeaderboardTimeRange,
} from '@/lib/data/visible-leaderboard-sources'

const VALID_TIME_RANGES: readonly LeaderboardTimeRange[] = ['7D', '30D', '90D']

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const handler = withPublic(
    async ({ supabase }) => {
      const rawTimeRange = request.nextUrl.searchParams.get('timeRange')?.toUpperCase() ?? '90D'
      if (!VALID_TIME_RANGES.includes(rawTimeRange as LeaderboardTimeRange)) {
        throw ApiError.validation('Invalid timeRange. Must be one of: 7D, 30D, 90D')
      }
      const timeRange = rawTimeRange as LeaderboardTimeRange

      const { data, error } = await supabase.rpc('arena_visible_sources', {
        p_season_id: timeRange,
      })
      if (error) throw new Error(`arena_visible_sources failed: ${error.message}`)

      const sources = parseVisibleLeaderboardSources(data)
      return withCache(apiSuccess({ timeRange, sources }), {
        maxAge: 60,
        staleWhileRevalidate: 300,
      })
    },
    { name: 'sources-visible', rateLimit: 'public' }
  )
  return handler(request)
}
