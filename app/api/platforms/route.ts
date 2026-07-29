/**
 * GET /api/platforms
 *
 * Returns configured source boards that have historical data.
 * This is not a live serving count and not a count of exchange companies.
 */

import { NextResponse } from 'next/server'
import { EXCHANGE_CONFIG, DEAD_BLOCKED_PLATFORMS, SOURCES_WITH_DATA } from '@/lib/constants/exchanges'
import { isPublicRankingSourceAllowed } from '@/lib/rankings/publication-policy'
import { createLogger } from '@/lib/utils/logger'

const logger = createLogger('platforms-api')

export const revalidate = 3600 // 1 hour ISR

const deadSet = new Set<string>(DEAD_BLOCKED_PLATFORMS)

export async function GET() {
  try {
    const platforms = SOURCES_WITH_DATA
      .filter(source => !deadSet.has(source))
      .map(source => {
        const config = EXCHANGE_CONFIG[source]
        return {
          id: source,
          name: config?.name || source,
          type: config?.sourceType || 'futures',
          reliability: config?.reliability || 0,
          // Static input-policy status only. Actual publication additionally
          // requires an active serving registry row and rankable live data.
          publicRankingInputAllowed: isPublicRankingSourceAllowed(source),
        }
      })

    return NextResponse.json(
      {
        // `platforms` and `total` remain for compatibility. The explicit
        // machine-readable fields prevent consumers from treating boards as
        // exchange companies or as proof that a board is live.
        platforms,
        total: platforms.length,
        countUnit: 'source_board',
        scope: 'configured_source_boards_with_historical_data',
      },
      { headers: { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=7200' } }
    )
  } catch (error) {
    logger.error('platforms-api error', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
