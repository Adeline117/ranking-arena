/**
 * GET /api/platforms/health
 *
 * Returns health status for all platforms.
 * Used by frontend to show which platforms are available.
 * Redis-cached for 30 seconds.
 */

import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { withPublic } from '@/lib/api/middleware'
import { getOrSetWithLock } from '@/lib/cache'
import { buildPlatformHealth, type PlatformFreshnessRow } from '@/lib/services/platform-health'

export const dynamic = 'force-dynamic'

export const GET = withPublic(
  async ({ supabase }) => {
    const result = await getOrSetWithLock(
      'api:platforms:health',
      async () => computePlatformHealth(supabase as SupabaseClient),
      { ttl: 30, lockTtl: 10 }
    )

    return NextResponse.json(result, {
      headers: { 'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60' },
    })
  },
  { name: 'platforms/health', rateLimit: 'public' }
)

async function computePlatformHealth(supabase: SupabaseClient) {
  // Registry-backed fetch freshness is the source-membership authority. Cron
  // names are orchestration details and can accidentally invent platforms such
  // as "market-data" when parsed with a fetch-* regex.
  const { data, error } = await supabase.rpc('get_platform_freshness')
  if (error) {
    throw new Error(`active platform freshness unavailable: ${error.message}`)
  }

  const health = buildPlatformHealth({
    freshnessRows: (data || []) as PlatformFreshnessRow[],
    logs: [],
    now: Date.now(),
  })

  return {
    platforms: health.map((platform) => ({
      platform: platform.platform,
      status: platform.status,
      last_check: platform.lastUpdate,
    })),
    freshness: Object.fromEntries(
      health
        .filter((platform) => platform.lastUpdate !== null)
        .map((platform) => [platform.platform, platform.lastUpdate])
    ),
  }
}
