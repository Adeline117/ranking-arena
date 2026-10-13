/**
 * GET /api/platforms/health
 *
 * Returns health status for all platforms.
 * Used by frontend to show which platforms are available.
 * Pipeline-log timestamps are operational signals only. They are never
 * substituted with raw score computation timestamps: `computed_at` cannot
 * prove when a platform's upstream data was last observed.
 */

import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { withPublic } from '@/lib/api/middleware'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export const GET = withPublic(
  async ({ supabase }) => {
    const result = await computePlatformHealth(supabase as SupabaseClient)

    return NextResponse.json(result, {
      headers: {
        'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
        'CDN-Cache-Control': 'no-store',
        'Vercel-CDN-Cache-Control': 'no-store',
      },
    })
  },
  { name: 'platforms/health', rateLimit: 'public' }
)

export async function computePlatformHealth(supabase: SupabaseClient) {
  // Run both queries in parallel instead of sequentially
  const [healthResult, pipelineLogsResult] = await Promise.all([
    supabase
      .from('platform_health')
      .select('platform, status, last_success_at, error_count:consecutive_failures')
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

  return {
    platforms: health || [],
    freshness: Object.fromEntries(latestByPlatform),
    freshness_visibility: latestByPlatform.size > 0 ? ('verified' as const) : ('unknown' as const),
    freshness_reason:
      latestByPlatform.size > 0
        ? null
        : pipelineLogsResult.error
          ? 'pipeline_logs_unavailable'
          : 'pipeline_freshness_unavailable',
  }
}
