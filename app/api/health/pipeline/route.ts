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
  const sevenDaysAgo = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString()

  // ROOT CAUSE FIX (2026-04-08): Was firing 62 parallel queries which exhausted
  // Supabase pool (60 connections). Now uses RPC with GROUP BY (1 query, returns
  // 1 row per platform — ~31 rows total, fast).
  const [allLogsRes, lbLatestRes] = await Promise.all([
    supabase
      .from('pipeline_logs')
      .select('job_name, records_processed')
      .eq('status', 'success')
      .gte('started_at', sevenDaysAgo)
      .not('records_processed', 'is', null)
      .gt('records_processed', 0),
    // RPC executes server-side GROUP BY — returns one row per platform.
    // Falls back to 50000-row query if RPC doesn't exist.
    supabase.rpc('get_leaderboard_latest_by_source').then(
      r => r.error ? supabase
        .from('leaderboard_ranks')
        .select('source, computed_at')
        .gte('computed_at', new Date(now - 24 * 60 * 60 * 1000).toISOString())
        .order('computed_at', { ascending: false })
        .limit(50000)
      : r
    ),
  ])

  // Build platform → latest computed_at map
  const platformLastUpdate = new Map<string, string>()
  const lbData = (lbLatestRes.data || []) as Array<{ source: string; computed_at?: string; latest?: string }>
  for (const row of lbData) {
    const ts = row.computed_at || row.latest
    if (!ts) continue
    if (!platformLastUpdate.has(row.source) || (platformLastUpdate.get(row.source) ?? '') < ts) {
      platformLastUpdate.set(row.source, ts)
    }
  }

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

  const results: PlatformHealth[] = activePlatforms.map((platform) => {
    const config = EXCHANGE_CONFIG[platform as keyof typeof EXCHANGE_CONFIG]
    const displayName = config?.name || platform

    const lastUpdate = platformLastUpdate.get(platform) || null
    const currentCount = 0 // Skipped to reduce DB load — was 31 extra count queries
    const avgCount = platformAvgRecords.get(platform) ?? null

    let ageHours: number | null = null
    if (lastUpdate) {
      ageHours = Math.round(((now - new Date(lastUpdate).getTime()) / (1000 * 60 * 60)) * 10) / 10
    }

    const countRatio = avgCount != null && avgCount > 0 ? currentCount / avgCount : null

    let status: 'healthy' | 'warning' | 'critical' = 'healthy'
    if (ageHours == null || ageHours > 24) {
      // null means no data in last 24h (query limited to 24h for perf)
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
