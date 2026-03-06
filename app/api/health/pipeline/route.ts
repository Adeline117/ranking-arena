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

  const [jobStatuses, jobStats, recentFailures] = await Promise.all([
    PipelineLogger.getJobStatuses(),
    PipelineLogger.getJobStats(),
    PipelineLogger.getRecentFailures(10),
  ])

  // Calculate overall pipeline health
  const totalJobs = jobStatuses.length
  const healthyJobs = jobStatuses.filter(j => j.health_status === 'healthy').length
  const failedJobs = jobStatuses.filter(j => j.health_status === 'failed').length
  const staleJobs = jobStatuses.filter(j => j.health_status === 'stale').length
  const stuckJobs = jobStatuses.filter(j => j.health_status === 'stuck').length

  let overallStatus: 'healthy' | 'degraded' | 'critical' = 'healthy'
  if (stuckJobs > 0 || failedJobs > totalJobs * 0.3) {
    overallStatus = 'critical'
  } else if (failedJobs > 0 || staleJobs > totalJobs * 0.2) {
    overallStatus = 'degraded'
  }

  // Average success rate across all jobs
  const avgSuccessRate = jobStats.length > 0
    ? jobStats.reduce((sum, j) => sum + (j.success_rate || 0), 0) / jobStats.length
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
