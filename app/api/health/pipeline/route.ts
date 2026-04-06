/**
 * Pipeline Health API - designed for external monitoring (OpenClaw)
 *
 * GET /api/health/pipeline
 * Returns per-job health status, per-platform data freshness,
 * success rates, recent failures, and an overall pipeline health score.
 *
 * Auth: Requires CRON_SECRET or service role key
 */

import { NextRequest, NextResponse } from 'next/server'
import { env } from '@/lib/env'
import { PipelineLogger } from '@/lib/services/pipeline-logger'
import { DEAD_BLOCKED_PLATFORMS, EXCHANGE_CONFIG } from '@/lib/constants/exchanges'
import { getSupportedPlatforms } from '@/lib/cron/fetchers'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { tieredGetOrSet } from '@/lib/cache/redis-layer'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

function verifyAuth(req: NextRequest): boolean {
  const auth = req.headers.get('authorization')
  const cronSecret = env.CRON_SECRET
  if (!cronSecret) return false
  return auth === `Bearer ${cronSecret}`
}

export interface PlatformHealth {
  platform: string
  displayName: string
  lastUpdate: string | null
  ageHours: number | null
  currentCount: number
  avgCount: number | null
  countRatio: number | null
  status: 'healthy' | 'warning' | 'critical'
}

/**
 * Check per-platform data health from trader_snapshots_v2
 */
async function getPlatformHealthData(): Promise<PlatformHealth[]> {
  const supabase = getSupabaseAdmin()
  const deadSet = new Set<string>([...DEAD_BLOCKED_PLATFORMS])
  const activePlatforms = getSupportedPlatforms().filter(p => !deadSet.has(p))
  const now = Date.now()
  const sixHoursAgo = new Date(now - 6 * 60 * 60 * 1000).toISOString()
  const sevenDaysAgo = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString()

  // Fetch ALL pipeline_logs once (was: 25 separate LIKE '%platform%' queries = 9.4M ms DB time)
  const [allLogsRes, ...platformChecks] = await Promise.all([
    supabase
      .from('pipeline_logs')
      .select('job_name, records_processed')
      .eq('status', 'success')
      .gte('started_at', sevenDaysAgo)
      .not('records_processed', 'is', null)
      .gt('records_processed', 0),
    // Per-platform snapshot queries (these use indexes, ~1ms each)
    ...activePlatforms.flatMap(platform => [
      supabase
        .from('trader_snapshots_v2')
        .select('updated_at')
        .eq('platform', platform)
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase
        .from('trader_snapshots_v2')
        .select('id', { count: 'exact', head: true })
        .eq('platform', platform)
        .gte('updated_at', sixHoursAgo),
    ]),
  ])

  // Build per-platform avg records from pipeline_logs (JS-side grouping)
  const platformAvgRecords = new Map<string, number>()
  const allLogs = allLogsRes.data || []
  for (const platform of activePlatforms) {
    const matching = allLogs.filter(l => l.job_name.includes(platform))
    if (matching.length > 0) {
      const avg = matching.reduce((sum, r) => sum + (r.records_processed || 0), 0) / matching.length
      platformAvgRecords.set(platform, avg)
    }
  }

  const results: PlatformHealth[] = activePlatforms.map((platform, i) => {
    const config = EXCHANGE_CONFIG[platform as keyof typeof EXCHANGE_CONFIG]
    const displayName = config?.name || platform
    const latestRes = platformChecks[i * 2] as { data: { updated_at: string } | null }
    const recentCountRes = platformChecks[i * 2 + 1] as { count: number | null }

    const lastUpdate = latestRes?.data?.updated_at || null
    const currentCount = recentCountRes?.count || 0
    const avgCount = platformAvgRecords.get(platform) ?? null

    let ageHours: number | null = null
    if (lastUpdate) {
      ageHours = Math.round(((now - new Date(lastUpdate).getTime()) / (1000 * 60 * 60)) * 10) / 10
    }

    const countRatio = avgCount != null && avgCount > 0 ? currentCount / avgCount : null

    let status: 'healthy' | 'warning' | 'critical' = 'healthy'
    if (ageHours == null || ageHours > 12) {
      status = 'critical'
    } else if (ageHours > 6) {
      status = 'warning'
    } else if (countRatio != null && countRatio < 0.3) {
      status = 'warning'
    }

    return {
      platform,
      displayName,
      lastUpdate,
      ageHours,
      currentCount,
      avgCount: avgCount != null ? Math.round(avgCount) : null,
      countRatio: countRatio != null ? Math.round(countRatio * 100) / 100 : null,
      status,
    }
  })

  results.sort((a, b) => a.platform.localeCompare(b.platform))
  return results
}

export async function GET(req: NextRequest) {
  if (!verifyAuth(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    // Cache the entire health response for 2 minutes (health data doesn't change fast)
    const CACHE_KEY = 'api:health:pipeline'
    const result = await tieredGetOrSet(
      CACHE_KEY,
      async () => {
        const [jobStatuses, jobStats, recentFailuresRaw, platformHealth] = await Promise.all([
          PipelineLogger.getJobStatuses(),
          PipelineLogger.getJobStats(),
          PipelineLogger.getRecentFailures(10),
          getPlatformHealthData(),
        ])

        // Filter out dead/blocked platforms from failure counts
        const deadSet = new Set<string>([...DEAD_BLOCKED_PLATFORMS])
        const isDeadPlatformJob = (jobName: string) => {
          for (const dead of deadSet) {
            if (jobName.includes(dead)) return true
          }
          return false
        }
        const recentFailures = recentFailuresRaw.filter(
          (f: { job_name?: string }) => !isDeadPlatformJob(f.job_name || '')
        )

        // Calculate overall pipeline health (excluding dead platforms)
        const activeJobs = jobStatuses.filter(j => !isDeadPlatformJob(j.job_name || ''))
        const totalJobs = activeJobs.length
        const healthyJobs = activeJobs.filter(j => j.health_status === 'healthy').length
        const failedJobs = activeJobs.filter(j => j.health_status === 'failed').length
        const staleJobs = activeJobs.filter(j => j.health_status === 'stale').length
        const stuckJobs = activeJobs.filter(j => j.health_status === 'stuck').length

        // Platform health summary
        const platformHealthy = platformHealth.filter(p => p.status === 'healthy').length
        const platformWarning = platformHealth.filter(p => p.status === 'warning').length
        const platformCritical = platformHealth.filter(p => p.status === 'critical').length

        let overallStatus: 'healthy' | 'degraded' | 'critical' = 'healthy'
        if (stuckJobs > 0 || failedJobs > totalJobs * 0.3 || platformCritical > platformHealth.length * 0.3) {
          overallStatus = 'critical'
        } else if (failedJobs > 0 || staleJobs > totalJobs * 0.2 || platformWarning > platformHealth.length * 0.3) {
          overallStatus = 'degraded'
        }

        // Average success rate across active jobs only (exclude dead platforms)
        const activeStats = jobStats.filter(j => !isDeadPlatformJob(j.job_name || ''))
        const avgSuccessRate = activeStats.length > 0
          ? activeStats.reduce((sum, j) => sum + (j.success_rate || 0), 0) / activeStats.length
          : 0

        return {
          status: overallStatus,
          timestamp: new Date().toISOString(),
          summary: {
            totalJobs,
            healthyJobs,
            failedJobs,
            staleJobs,
            stuckJobs,
            avgSuccessRate7d: Math.round(avgSuccessRate * 10) / 10,
            platformHealthy,
            platformWarning,
            platformCritical,
            totalPlatforms: platformHealth.length,
          },
          platformHealth,
          jobs: jobStatuses,
          stats: jobStats,
          recentFailures,
        }
      },
      'warm', // warm tier: 2 min memory, 15 min Redis (we override with custom TTL via tier)
      ['pipeline-health']
    )

    return NextResponse.json(result, {
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch (_err) {
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500, headers: { 'Cache-Control': 'no-store' } }
    )
  }
}
