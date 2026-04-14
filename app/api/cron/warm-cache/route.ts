/**
 * GET /api/cron/warm-cache
 *
 * Lightweight cron that keeps the Supabase connection pool warm
 * and refreshes the SSR homepage Redis cache (home-initial-traders:90D).
 *
 * Runs every 5 minutes (configured in vercel.json) to ensure:
 * 1. Supabase connection pool stays warm (no cold-start latency)
 * 2. Homepage SSR cache stays fresh (TTL=2min, so we refresh every 5min)
 *    Prevents cold-DB-query on page load → faster LCP
 *
 * Schedule: every 5 minutes (configured in vercel.json)
 */

import { NextRequest, NextResponse } from 'next/server'
import { env } from '@/lib/env'
import { fetchLeaderboardFromDB } from '@/lib/getInitialTraders'
import { PipelineLogger } from '@/lib/services/pipeline-logger'
import { createLogger } from '@/lib/utils/logger'
import { verifyCronSecret } from '@/lib/auth/verify-service-auth'

const logger = createLogger('warm-cache')

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(request: NextRequest) {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const start = Date.now()
  const plog = await PipelineLogger.start('warm-cache')

  try {
    // Warm the SSR homepage cache — 10s timeout to prevent hang during DB spikes
    let traders: Awaited<ReturnType<typeof fetchLeaderboardFromDB>>['traders'] = []
    try {
      const result = await Promise.race([
        fetchLeaderboardFromDB('90D', 50),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('warm-cache DB timeout')), 10000)),
      ])
      traders = result.traders
    } catch (err) {
      logger.warn(`[warm-cache] DB fetch failed: ${err instanceof Error ? err.message : err}`)
    }

    // Pre-warm high-traffic API caches to prevent 3s cold starts
    const baseUrl = request.nextUrl.origin
    const warmResults = await Promise.allSettled([
      fetch(`${baseUrl}/api/traders?timeRange=90D&limit=50`, { cache: 'no-store' }),
      fetch(`${baseUrl}/api/rankings/platform-stats`, { cache: 'no-store' }),
    ])
    const warmedApis = warmResults.filter(r => r.status === 'fulfilled' && r.value.ok).length
    const failedApis = warmResults.filter(r => r.status === 'rejected' || (r.status === 'fulfilled' && !r.value.ok)).length
    if (failedApis > 0) {
      logger.warn(`[warm-cache] ${failedApis} API warmup(s) returned non-200 or failed`)
    }

    const duration = Date.now() - start
    await plog.success(traders.length, { apis_warmed: warmedApis })

    return NextResponse.json({
      ok: true,
      traders_cached: traders.length,
      apis_warmed: warmedApis,
      duration_ms: duration,
      warmed_at: new Date().toISOString(),
    })
  } catch (err) {
    const duration = Date.now() - start
    await plog.error(err instanceof Error ? err : new Error(String(err)))
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : 'Unknown error',
        duration_ms: duration,
      },
      { status: 500 }
    )
  }
}
