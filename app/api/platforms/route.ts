/**
 * GET /api/platforms
 *
 * Returns the list of active exchange platforms with metadata.
 */

import { NextResponse } from 'next/server'
import { EXCHANGE_CONFIG, DEAD_BLOCKED_PLATFORMS, SOURCES_WITH_DATA } from '@/lib/constants/exchanges'

export const revalidate = 3600 // 1 hour ISR

const deadSet = new Set<string>(DEAD_BLOCKED_PLATFORMS)

export async function GET() {
  const platforms = SOURCES_WITH_DATA
    .filter(source => !deadSet.has(source))
    .map(source => {
      const config = EXCHANGE_CONFIG[source]
      return {
        id: source,
        name: config?.name || source,
        type: config?.sourceType || 'futures',
        reliability: config?.reliability || 0,
      }
    })

  return NextResponse.json(
    { platforms, total: platforms.length },
    { headers: { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=7200' } }
  )
}
