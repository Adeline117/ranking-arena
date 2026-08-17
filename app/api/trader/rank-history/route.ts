import { NextResponse } from 'next/server'
import { withPublic } from '@/lib/api/middleware'
import { badRequest } from '@/lib/api/response'
import {
  noStorePublicRankHistory,
  unavailablePublicRankHistoryProvenance,
} from '@/lib/rankings/public-rank-history'

export const dynamic = 'force-dynamic'
export const revalidate = 0

/**
 * GET /api/trader/rank-history?platform=...&trader_key=...&period=90D&days=7
 *
 * `rank_history` currently has no immutable public publication proof. Return an
 * explicit empty, unverified trajectory rather than query or cache raw points.
 */
export const GET = withPublic(
  async ({ request }) => {
    const { searchParams } = request.nextUrl
    const platform = searchParams.get('platform')
    const traderKey = searchParams.get('trader_key')
    const period = searchParams.get('period') || '90D'

    if (!platform || !traderKey) {
      return badRequest('Missing required params: platform, trader_key')
    }

    return noStorePublicRankHistory(
      NextResponse.json({
        history: [],
        platform,
        trader_key: traderKey,
        period,
        ...unavailablePublicRankHistoryProvenance(),
      })
    )
  },
  { name: 'rank-history', rateLimit: 'public' }
)
