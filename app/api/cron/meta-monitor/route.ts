/**
 * Meta-monitor: "监控的监控"
 * Checks that all cron jobs are running on schedule.
 * If any job hasn't succeeded in 2x its expected interval, sends alert.
 * Runs every 6 hours. This route checks each job against 2x its configured
 * expected interval; the scheduler cadence controls how soon that breach is
 * observed.
 */

import { NextRequest } from 'next/server'
import { PipelineLogger } from '@/lib/services/pipeline-logger'
import { sendRateLimitedAlert } from '@/lib/alerts/send-alert'
import { logger } from '@/lib/logger'
import { withCron } from '@/lib/api/with-cron'
import { findStuckCronJobs } from '@/lib/cron/meta-monitor-policy'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 30

// Expected max interval (minutes) for each job group.
// Every key MUST be a job that still exists (an app/api/cron/<name> route):
// a job with no producer can only ever report "NEVER" and trains everyone to
// ignore this alert (2026-11 audit P2-1 removed 8 such entries:
// batch-fetch-traders, batch-enrich, fetch-details, backfill-data,
// link-entities, verify-fetchers, snapshot-positions, auto-post-insights).
// Locked by __tests__/expected-intervals.test.ts.
const EXPECTED_INTERVALS: Record<string, number> = {
  // Core pipeline
  'compute-leaderboard': 60,
  'precompute-composite': 240,

  // Discovery & enrichment
  'generate-profiles': 720,

  // Market data
  'flash-news-fetch': 60,

  // Monitoring & health
  'cleanup-deleted-accounts': 1440,

  // Snapshots & ranks
  'snapshot-ranks': 1440,

  // Search & cache
  'sync-meilisearch': 60,

  // Social
  'auto-post-market-summary': 1440,
  'auto-post-twitter': 1440,
  'daily-digest': 1440,

  // Subscriptions
  'subscription-expiry': 1440,
  'reconcile-subscriptions': 1440,
  'stripe-readiness': 1440,
}

export const GET = withCron('meta-monitor', async (_request: NextRequest) => {
  const statuses = await PipelineLogger.getJobStatuses()
  const stuckJobs = findStuckCronJobs(statuses, EXPECTED_INTERVALS)

  if (stuckJobs.length > 0) {
    const jobList = stuckJobs
      .map(
        (j) =>
          `\u2022 ${j.job}: last success ${j.actualMinutes === -1 ? 'NEVER' : `${j.actualMinutes}m ago`} (expected: every ${j.expectedMinutes}m)`
      )
      .join('\n')

    const jobKey = stuckJobs
      .map((j) => j.job)
      .sort()
      .join(',')
    await sendRateLimitedAlert(
      {
        title: `Meta-Monitor: ${stuckJobs.length} cron jobs 异常`,
        message: `以下 cron job 超过预期间隔未成功运行:\n\n${jobList}`,
        level: stuckJobs.length >= 3 ? 'critical' : 'warning',
        details: {
          stuck_count: stuckJobs.length,
          total_monitored: Object.keys(EXPECTED_INTERVALS).length,
        },
      },
      `meta-monitor:${jobKey}`,
      3 * 60 * 60 * 1000
    )
  }

  logger.info(
    `[meta-monitor] Checked ${Object.keys(EXPECTED_INTERVALS).length} jobs, ${stuckJobs.length} stuck`
  )

  return {
    count: stuckJobs.length,
    monitored: Object.keys(EXPECTED_INTERVALS).length,
    stuck: stuckJobs.length,
    stuckJobs,
  }
})
