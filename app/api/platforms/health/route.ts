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
import logger from '@/lib/logger'

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
  // Run both queries in parallel instead of sequentially
  const [healthResult, pipelineLogsResult] = await Promise.all([
    supabase
      .from('platform_health')
      .select('platform, status, last_success_at, error_count, avg_response_ms')
      .order('platform'),
    supabase
      .from('pipeline_logs')
      .select('job_name, ended_at')
      .eq('status', 'success')
      .order('ended_at', { ascending: false })
      .limit(200),
  ])

  const health = healthResult.data
  const pipelineLogs = pipelineLogsResult.data

  // Get latest data timestamps per platform from pipeline_logs
  const latestByPlatform = new Map<string, string>()

  for (const row of pipelineLogs || []) {
    const match = row.job_name?.match(/(?:fetch|enrich)-(.+)/)
    if (match) {
      const platform = match[1]
      if (!latestByPlatform.has(platform)) {
        latestByPlatform.set(platform, row.ended_at)
      }
    }
  }

  // Fallback: use leaderboard_ranks (only if pipeline_logs empty)
  if (latestByPlatform.size === 0) {
    const { data: lbFreshness } = await supabase
      .from('leaderboard_ranks')
      .select('platform, updated_at')
      .eq('season_id', '90D')
      .order('updated_at', { ascending: false })
      .limit(100)

    for (const row of lbFreshness || []) {
      const key = row.platform
      if (key && !latestByPlatform.has(key)) {
        latestByPlatform.set(key, row.updated_at)
      }
    }
  }

  return {
    platforms: health || [],
    freshness: Object.fromEntries(latestByPlatform),
  }
}
