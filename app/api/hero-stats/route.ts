/**
 * Hero Stats API
 *
 * GET /api/hero-stats
 *
 * Exposes the SAME server-side hero stats the homepage uses
 * (`lib/data/hero-stats.ts` → `get_hero_stats` RPC) to client components.
 *
 * Consumed by CrossExchangePercentileBadge, which needs the total tracked
 * trader count (90D ranked) as the denominator for an accurate cross-exchange
 * percentile. Reuses the hero's count source so the badge never hardcodes a
 * separate number.
 *
 * Response: { sourceBoardCount, exchangeCount, traderCount, isDefault? }
 * Cache: 1 hour (getHeroStats already caches in Redis; CDN caches the response).
 */

import { NextResponse } from 'next/server'
import { getHeroStats } from '@/lib/data/hero-stats'

export const runtime = 'nodejs'

export async function GET() {
  // getHeroStats never throws — it returns defaults on any failure.
  const stats = await getHeroStats()
  return NextResponse.json(
    {
      ...stats,
      // Deprecated compatibility field for older clients. Its value is a live
      // ranking source-board count, not a count of exchange companies.
      exchangeCount: stats.sourceBoardCount,
    },
    {
      headers: {
        'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=86400',
      },
    }
  )
}
