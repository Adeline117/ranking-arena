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
import { getFireAndForgetStats } from '@/lib/utils/logger'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 60

function verifyAuth(req: NextRequest): boolean {
  const auth = req.headers.get('authorization')
  const cronSecret = env.CRON_SECRET
  if (!cronSecret) return false
  return auth === `Bearer ${cronSecret}`
}

/**
 * Race any promise against a hard timeout — returns fallback if it exceeds the deadline.
 * Critical: /api/health/pipeline must never hang the monitor. Each sub-query gets a cap.
 * Accepts PromiseLike so Supabase query builders can be passed directly.
 */
async function withDeadline<T>(promise: PromiseLike<T>, ms: number, fallback: T, label: string): Promise<T> {
  return Promise.race([
    Promise.resolve(promise),
    new Promise<T>((resolve) => setTimeout(() => {
      console.warn(`[health/pipeline] ${label} exceeded ${ms}ms, returning fallback`)
      resolve(fallback)
    }, ms)),
  ])
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
  //
  // ROOT CAUSE FIX (2026-04-09): Added per-query 10s deadlines. The RPC
  // occasionally hangs 30s+ under load and was causing the entire endpoint
  // (and therefore the external monitor) to time out. Individual queries must
  // fail fast so the overall response still returns within the monitor budget.
  const emptyResponse = { data: [] as unknown[], error: null } as unknown
  const [allLogsRes, lbLatestRes] = await Promise.all([
    withDeadline(
      supabase
        .from('pipeline_logs')
        .select('job_name, records_processed')
        .eq('status', 'success')
        .gte('started_at', sevenDaysAgo)
        .not('records_processed', 'is', null)
        .gt('records_processed', 0) as unknown as PromiseLike<{ data: Array<{ job_name: string; records_processed: number }> | null; error: unknown }>,
      10_000,
      emptyResponse as { data: Array<{ job_name: string; records_processed: number }> | null; error: unknown },
      'pipeline_logs records_processed'
    ),
    // ROOT CAUSE FIX (2026-04-10): Use pg Pool directly instead of Supabase REST.
    // PostgREST connection pool gets overwhelmed during cron storms → RPC times out
    // → all platforms return null → all show as critical.
    // pg Pool on port 6543 (transaction mode) is much more reliable.
    (async () => {
      try {
        const { query: dbQuery } = await import('@/lib/db')
        const result = await dbQuery(
          `SELECT source, MAX(computed_at) as computed_at FROM leaderboard_ranks WHERE computed_at >= NOW() - INTERVAL '7 days' GROUP BY source`,
          []
        )
        return { data: result.rows, error: null }
      } catch (err) {
        return { data: null, error: err }
      }
    })() as unknown as PromiseLike<{ data: Array<{ source: string; computed_at?: string }> | null; error: unknown }>,
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
    // Count queries removed to reduce DB load (was 31 extra queries).
    // countRatio check disabled — it always triggered false warning when currentCount=0.
    const currentCount = 0
    const avgCount = platformAvgRecords.get(platform) ?? null

    let ageHours: number | null = null
    if (lastUpdate) {
      ageHours = Math.round(((now - new Date(lastUpdate).getTime()) / (1000 * 60 * 60)) * 10) / 10
    }

    const countRatio = null // Disabled: no count data available without per-platform queries

    let status: 'healthy' | 'warning' | 'critical' = 'healthy'
    if (ageHours == null || ageHours > 24) {
      status = 'critical'
    } else if (ageHours > 6) {
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
        // Hard per-query deadlines: if any one query gets stuck, we still return
        // a (partial) response instead of hanging the monitor's fetch.
        const [jobStatuses, jobStats, recentFailuresRaw, platformHealth] = await Promise.all([
          withDeadline(PipelineLogger.getJobStatuses(), 15_000, [], 'getJobStatuses'),
          withDeadline(PipelineLogger.getJobStats(), 15_000, [], 'getJobStats'),
          withDeadline(PipelineLogger.getRecentFailures(10), 10_000, [], 'getRecentFailures'),
          withDeadline(getPlatformHealthData(), 20_000, [] as PlatformHealth[], 'getPlatformHealthData'),
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

        // Background task failures — surface silent fireAndForget errors that
        // would otherwise only live in the serverless instance's memory. Only
        // labels with >= 3 failures (the escalation threshold) are included —
        // single transient failures are expected and not actionable.
        // Retro 2026-04-09: OpenClaw never saw these before this change.
        const rawFfStats = getFireAndForgetStats()
        const backgroundFailures = Object.entries(rawFfStats)
          .filter(([, s]) => s.count >= 3)
          .map(([label, s]) => ({
            label,
            count: s.count,
            lastError: s.lastError,
            lastAt: s.lastAt,
          }))
          .sort((a, b) => b.count - a.count)

        // Escalate status if many silent background failures detected
        if (backgroundFailures.length >= 5 && overallStatus === 'healthy') {
          overallStatus = 'degraded'
        }

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
            backgroundFailureCount: backgroundFailures.length,
          },
          platformHealth,
          jobs: jobStatuses,
          stats: jobStats,
          recentFailures,
          backgroundFailures,
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
