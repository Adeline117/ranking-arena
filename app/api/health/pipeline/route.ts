/**
 * Pipeline Health API - designed for external monitoring (OpenClaw)
 *
 * GET /api/health/pipeline
 * Returns per-job health status, success rates, recent failures,
 * and an overall pipeline health score.
 *
 * Auth: Requires CRON_SECRET or service role key
 */

import { NextRequest, NextResponse } from 'next/server'
import { PipelineLogger } from '@/lib/services/pipeline-logger'
import { DEAD_BLOCKED_PLATFORMS } from '@/lib/constants/exchanges'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

function verifyAuth(req: NextRequest): boolean {
  const auth = req.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret) return false
  return auth === `Bearer ${cronSecret}`
}

export async function GET(req: NextRequest) {
  if (!verifyAuth(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const [jobStatuses, jobStats, recentFailuresRaw] = await Promise.all([
    PipelineLogger.getJobStatuses(),
    PipelineLogger.getJobStats(),
    PipelineLogger.getRecentFailures(10),
  ])

  // Filter out dead/blocked platforms from failure counts
  const deadSet = new Set<string>([
    ...DEAD_BLOCKED_PLATFORMS,
    'okx_spot', // No spot copy-trading API exists
  ])
  const isDeadPlatformJob = (jobName: string) => {
    // Check if any dead platform name appears in the job name
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

  let overallStatus: 'healthy' | 'degraded' | 'critical' = 'healthy'
  if (stuckJobs > 0 || failedJobs > totalJobs * 0.3) {
    overallStatus = 'critical'
  } else if (failedJobs > 0 || staleJobs > totalJobs * 0.2) {
    overallStatus = 'degraded'
  }

  // Average success rate across active jobs only (exclude dead platforms)
  const activeStats = jobStats.filter(j => !isDeadPlatformJob(j.job_name || ''))
  const avgSuccessRate = activeStats.length > 0
    ? activeStats.reduce((sum, j) => sum + (j.success_rate || 0), 0) / activeStats.length
    : 0

  return NextResponse.json({
    status: overallStatus,
    timestamp: new Date().toISOString(),
    summary: {
      totalJobs,
      healthyJobs,
      failedJobs,
      staleJobs,
      stuckJobs,
      avgSuccessRate7d: Math.round(avgSuccessRate * 10) / 10,
    },
    jobs: jobStatuses,
    stats: jobStats,
    recentFailures,
  }, {
    headers: { 'Cache-Control': 'no-store' },
  })
}
