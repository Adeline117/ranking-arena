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
import { logger } from '@/lib/logger'

export const dynamic = 'force-dynamic'

const PLATFORM_HEALTH_DEADLINE_MS = 6_000
const PLATFORM_HEALTH_CACHE_KEY = 'api:platforms:health:v2'

function runWithinDeadline<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  let settled = false

  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      controller.abort(new DOMException('Platform health deadline exceeded', 'TimeoutError'))
      reject(controller.signal.reason)
    }, PLATFORM_HEALTH_DEADLINE_MS)

    Promise.resolve()
      .then(() => operation(controller.signal))
      .then(
        (value) => {
          if (settled) return
          settled = true
          clearTimeout(timeout)
          resolve(value)
        },
        (error: unknown) => {
          if (settled) return
          settled = true
          clearTimeout(timeout)
          reject(error)
        }
      )
  })
}

export const GET = withPublic(
  async ({ supabase }) => {
    try {
      const result = await runWithinDeadline((signal) =>
        getOrSetWithLock(
          PLATFORM_HEALTH_CACHE_KEY,
          async () => computePlatformHealth(supabase, signal),
          { ttl: 30, lockTtl: 10, maxWaitMs: 1_500 }
        )
      )

      return NextResponse.json(result, {
        headers: { 'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60' },
      })
    } catch (error) {
      logger.warn('[platforms/health] Public health authority unavailable', {
        error: error instanceof Error ? error.message : String(error),
      })
      return NextResponse.json(
        { success: false, error: 'Platform health unavailable' },
        { status: 503, headers: { 'Cache-Control': 'no-store' } }
      )
    }
  },
  { name: 'platforms/health', rateLimit: 'public' }
)

export async function computePlatformHealth(supabase: SupabaseClient, signal: AbortSignal) {
  // Run both queries in parallel instead of sequentially
  const [healthResult, pipelineLogsResult] = await Promise.all([
    supabase
      .from('platform_health')
      .select('platform, status, last_success_at, error_count:consecutive_failures')
      .order('platform')
      .abortSignal(signal),
    supabase
      .from('pipeline_logs')
      .select('job_name, ended_at')
      .eq('status', 'success')
      .order('ended_at', { ascending: false })
      .limit(200)
      .abortSignal(signal),
  ])

  if (healthResult.error || pipelineLogsResult.error) {
    throw new Error('Platform health source query failed')
  }

  const health = healthResult.data
  const pipelineLogs = pipelineLogsResult.data

  // Get latest data timestamps per platform from pipeline_logs
  const latestByPlatform = new Map<string, string>()

  for (const row of pipelineLogs || []) {
    const match = row.job_name?.match(/(?:fetch|enrich)-(.+)/)
    if (match && typeof row.ended_at === 'string') {
      const platform = match[1]
      if (!latestByPlatform.has(platform)) {
        latestByPlatform.set(platform, row.ended_at)
      }
    }
  }

  // Fallback: use leaderboard_ranks (only if pipeline_logs empty)
  if (latestByPlatform.size === 0) {
    const { data: lbFreshness, error: lbFreshnessError } = await supabase
      .from('leaderboard_ranks')
      .select('platform:source, updated_at:computed_at')
      .eq('season_id', '90D')
      .order('computed_at', { ascending: false })
      .limit(100)
      .abortSignal(signal)

    if (lbFreshnessError) throw new Error('Platform freshness fallback query failed')

    for (const row of lbFreshness || []) {
      const key = row.platform
      if (key && typeof row.updated_at === 'string' && !latestByPlatform.has(key)) {
        latestByPlatform.set(key, row.updated_at)
      }
    }
  }

  return {
    platforms: health || [],
    freshness: Object.fromEntries(latestByPlatform),
  }
}
