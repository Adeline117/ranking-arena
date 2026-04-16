/**
 * Meta-monitor: "监控的监控"
 * Checks that all cron jobs are running on schedule.
 * If any job hasn't succeeded in 2x its expected interval, sends alert.
 * Runs hourly.
 */

import { NextRequest } from 'next/server'
import { PipelineLogger } from '@/lib/services/pipeline-logger'
import { sendRateLimitedAlert } from '@/lib/alerts/send-alert'
import { logger } from '@/lib/logger'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { withCron } from '@/lib/api/with-cron'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 30

// Expected max interval (minutes) for each job group
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

  // Subscriptions
  'subscription-expiry': 1440,
}

export const GET = withCron('meta-monitor', async (_request: NextRequest) => {
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
    let latestSuccess: string | null = null
    for (const [jobName, lastTime] of lastSuccessMap.entries()) {
      if (jobName === jobPrefix || jobName.startsWith(`${jobPrefix}-`)) {
        if (!latestSuccess || lastTime > latestSuccess) {
          latestSuccess = lastTime
        }
      }
    }

    if (!latestSuccess) {
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

    const jobKey = stuckJobs.map(j => j.job).sort().join(',')
    await sendRateLimitedAlert({
      title: `Meta-Monitor: ${stuckJobs.length} cron jobs 异常`,
      message: `以下 cron job 超过预期间隔未成功运行:\n\n${jobList}`,
      level: stuckJobs.length >= 3 ? 'critical' : 'warning',
      details: {
        stuck_count: stuckJobs.length,
        total_monitored: Object.keys(EXPECTED_INTERVALS).length,
      },
    }, `meta-monitor:${jobKey}`, 3 * 60 * 60 * 1000)
  }

  // Check if historical data cleanup is complete
  let cleanupComplete = false
  try {
    const supabase = getSupabaseAdmin()
    const { data: cleanupStatus } = await supabase.from('pipeline_logs').select('metadata').eq('job_name', 'cleanup-violations').order('started_at', { ascending: false }).limit(1).single()
    if (cleanupStatus?.metadata && typeof cleanupStatus.metadata === 'object') {
      const meta = cleanupStatus.metadata as Record<string, unknown>
      if (meta.done === true || meta.fixed === 0) {
        cleanupComplete = true
        await sendRateLimitedAlert({
          title: '历史数据清理完成!',
          message: '所有历史违规数据已清理完毕。请运行:\nbash scripts/post-cleanup-orchestrate.sh\n\n此脚本将: VALIDATE 约束 → 重算指标 → 重算 composite',
          level: 'info',
          details: { action: 'run post-cleanup-orchestrate.sh' },
        }, 'cleanup-complete', 24 * 60 * 60 * 1000)
      }
    }
  } catch (err) {
    // Best-effort check — but never silent. If this query breaks, the
    // cleanup-complete notification would stop firing with zero warning.
    logger.warn('[meta-monitor] cleanup-complete status check failed', {
      error: err instanceof Error ? err.message : String(err),
    })
  }

  logger.info(`[meta-monitor] Checked ${Object.keys(EXPECTED_INTERVALS).length} jobs, ${stuckJobs.length} stuck, cleanup=${cleanupComplete ? 'done' : 'running'}`)

  return {
    count: stuckJobs.length,
    monitored: Object.keys(EXPECTED_INTERVALS).length,
    stuck: stuckJobs.length,
    stuckJobs,
    cleanupComplete,
  }
})
