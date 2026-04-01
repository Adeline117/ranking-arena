/**
 * Meta-monitor: "监控的监控"
 * Checks that all cron jobs are running on schedule.
 * If any job hasn't succeeded in 2x its expected interval, sends alert.
 * Runs hourly.
 */

import { NextResponse } from 'next/server'
import { PipelineLogger } from '@/lib/services/pipeline-logger'
import { sendAlert } from '@/lib/alerts/send-alert'
import { env } from '@/lib/env'
import { logger } from '@/lib/logger'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 30

// Expected max interval (minutes) for each job group
// If a job hasn't succeeded in 2x this interval, it's considered stuck
const EXPECTED_INTERVALS: Record<string, number> = {
  // Core pipeline (every 30min-3h)
  'compute-leaderboard': 60,
  'batch-fetch-traders': 360, // groups run every 3-6h
  'batch-enrich': 480,
  'fetch-details': 60,
  'aggregate-daily-snapshots': 1440, // daily
  'compute-derived-metrics': 1440,
  'precompute-composite': 240,
  'calculate-advanced-metrics': 480,
  'backfill-data': 240,

  // Discovery & enrichment
  'batch-discover': 720,
  'generate-profiles': 720,
  'backfill-avatars': 1440,
  'link-entities': 1440,
  'batch-5min': 10,

  // Market data
  'fetch-market-data': 120,
  'fetch-funding-rates': 480,
  'fetch-open-interest': 240,
  'flash-news-fetch': 60,

  // Monitoring & health
  'verify-fetchers': 360,
  'check-data-freshness': 360,
  'check-data-gaps': 480,
  'check-trader-alerts': 720,
  'cleanup-stuck-logs': 120,
  'cleanup-data': 1440,
  'cleanup-deleted-accounts': 1440,

  // Snapshots & ranks
  'snapshot-positions': 120,
  'snapshot-ranks': 1440,

  // Search & cache
  'sync-meilisearch': 60,

  // Social
  'auto-post-market-summary': 1440,
  'auto-post-insights': 1440,
  'auto-post-twitter': 1440,
  'daily-digest': 1440,
  'ranking-change-notifications': 1440,

  // Subscriptions
  'subscription-expiry': 1440,
  'update-competitions': 60,
}

export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization')
  if (env.CRON_SECRET && authHeader !== `Bearer ${env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const plog = await PipelineLogger.start('meta-monitor')

  try {
    const statuses = await PipelineLogger.getJobStatuses()
    const now = Date.now()
    const stuckJobs: Array<{ job: string; lastSuccess: string; expectedMinutes: number; actualMinutes: number }> = []

    // Build a map of job_name -> last success time
    const lastSuccessMap = new Map<string, string>()
    for (const s of statuses) {
      if (s.status === 'success' || s.status === 'partial_success') {
        const existing = lastSuccessMap.get(s.job_name)
        if (!existing || s.started_at > existing) {
          lastSuccessMap.set(s.job_name, s.started_at)
        }
      }
    }

    // Check each monitored job against expected interval
    for (const [jobPrefix, expectedMinutes] of Object.entries(EXPECTED_INTERVALS)) {
      // Find the most recent success for any job matching this prefix
      let latestSuccess: string | null = null
      for (const [jobName, lastTime] of lastSuccessMap.entries()) {
        if (jobName === jobPrefix || jobName.startsWith(`${jobPrefix}-`)) {
          if (!latestSuccess || lastTime > latestSuccess) {
            latestSuccess = lastTime
          }
        }
      }

      if (!latestSuccess) {
        // Job has never succeeded in pipeline_logs -- could be new or very broken
        stuckJobs.push({ job: jobPrefix, lastSuccess: 'never', expectedMinutes, actualMinutes: -1 })
        continue
      }

      const minutesSince = (now - new Date(latestSuccess).getTime()) / 60_000
      const threshold = expectedMinutes * 2

      if (minutesSince > threshold) {
        stuckJobs.push({
          job: jobPrefix,
          lastSuccess: latestSuccess,
          expectedMinutes,
          actualMinutes: Math.round(minutesSince),
        })
      }
    }

    if (stuckJobs.length > 0) {
      const jobList = stuckJobs
        .map(j => `\u2022 ${j.job}: last success ${j.actualMinutes === -1 ? 'NEVER' : `${j.actualMinutes}m ago`} (expected: every ${j.expectedMinutes}m)`)
        .join('\n')

      await sendAlert({
        title: `Meta-Monitor: ${stuckJobs.length} cron jobs \u5F02\u5E38`,
        message: `\u4EE5\u4E0B cron job \u8D85\u8FC7\u9884\u671F\u95F4\u9694\u672A\u6210\u529F\u8FD0\u884C:\n\n${jobList}`,
        level: stuckJobs.length >= 3 ? 'critical' : 'warning',
        details: {
          stuck_count: stuckJobs.length,
          total_monitored: Object.keys(EXPECTED_INTERVALS).length,
        },
      })
    }

    await plog.success(stuckJobs.length, { stuck_jobs: stuckJobs.map(j => j.job) })

    logger.info(`[meta-monitor] Checked ${Object.keys(EXPECTED_INTERVALS).length} jobs, ${stuckJobs.length} stuck`)

    return NextResponse.json({
      ok: true,
      monitored: Object.keys(EXPECTED_INTERVALS).length,
      stuck: stuckJobs.length,
      stuckJobs,
    })
  } catch (error) {
    await plog.error(error)
    return NextResponse.json({ error: String(error) }, { status: 500 })
  }
}
