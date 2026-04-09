/**
 * GET /api/cron/health-check-all
 *
 * Comprehensive health check: frontend pages, API endpoints, data quality.
 * Runs every 30 minutes. Sends Telegram alert if score < 80.
 *
 * Covers:
 * - Core page load + SSR data verification (5 pages)
 * - API endpoint response validation (8 endpoints)
 * - Data quality: ranking order, duplicates, coverage, anomalies, freshness
 */

import { NextRequest, NextResponse } from 'next/server'
import { PipelineLogger } from '@/lib/services/pipeline-logger'
import { runFullHealthCheck } from '@/lib/harness/health-checks'
import { sendRateLimitedAlert } from '@/lib/alerts/send-alert'
import { PipelineState } from '@/lib/services/pipeline-state'
import { logger } from '@/lib/logger'
import { env } from '@/lib/env'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  if (env.CRON_SECRET && authHeader !== `Bearer ${env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const plog = await PipelineLogger.start('health-check-all')

  try {
    // Resolve base URL for self-checks
    const baseUrl = process.env.NEXT_PUBLIC_SITE_URL
      || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null)
      || request.nextUrl.origin

    // Safety timeout: race the full health check against a 45s deadline so
    // plog always has at least 15s to finalize before Vercel kills the fn.
    // Root cause: individual checks honor 10s timeouts but catastrophic DB
    // stalls (seen: seq scan on leaderboard_ranks under load) caused the
    // aggregate to exceed 60s, leaving pipeline_logs as 'running'.
    const HEALTH_CHECK_BUDGET_MS = 45_000
    const report = await Promise.race([
      runFullHealthCheck(baseUrl),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`runFullHealthCheck exceeded ${HEALTH_CHECK_BUDGET_MS}ms budget`)), HEALTH_CHECK_BUDGET_MS)
      ),
    ])

    // Store result for dashboard
    await PipelineState.set('health:latest', {
      score: report.score,
      overall: report.overall,
      checked_at: report.checked_at,
      pass: report.checks.filter(c => c.status === 'pass').length,
      warn: report.checks.filter(c => c.status === 'warn').length,
      fail: report.checks.filter(c => c.status === 'fail').length,
    })

    // Alert on degraded/critical
    if (report.overall !== 'healthy') {
      const failedChecks = report.checks.filter(c => c.status === 'fail')
      const warnChecks = report.checks.filter(c => c.status === 'warn')

      sendRateLimitedAlert(
        {
          title: `Health Check: ${report.overall.toUpperCase()} (score: ${report.score}/100)`,
          message: [
            ...failedChecks.map(c => `FAIL: ${c.name} — ${c.details}`),
            ...warnChecks.map(c => `WARN: ${c.name} — ${c.details}`),
          ].join('\n'),
          level: report.overall === 'critical' ? 'critical' : 'warning',
          details: { score: report.score, fail: failedChecks.length, warn: warnChecks.length },
        },
        'health-check:alert',
        30 * 60 * 1000 // 30min rate limit
      ).catch(err => logger.warn('[health-check] Alert failed:', err))
    }

    await plog.success(report.checks.length, { score: report.score, overall: report.overall })

    return NextResponse.json(report)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await plog.error(error instanceof Error ? error : new Error(message))
    return NextResponse.json({ success: false, error: message }, { status: 500 })
  }
}
