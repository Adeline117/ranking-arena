export interface PipelineJobStatus {
  job_name: string
  started_at: string
  status: string
}

export interface StuckCronJob {
  job: string
  lastSuccess: string
  expectedMinutes: number
  actualMinutes: number
}

/**
 * Expected max interval (minutes) per Vercel cron job group, read from
 * pipeline_logs. Every key MUST be a live (non-tombstone) app/api/cron/<name>
 * route: a job with no producer can only ever report "NEVER" and trains
 * everyone to ignore this alert (2026-11 audit P2-1).
 *
 * The worker pipeline is NOT tracked here: the workers do not write
 * pipeline_logs. Its single source of truth is the Redis output watermarks
 * (arena:worker:progress:*, lib/ingest/worker-progress.ts) read by
 * worker-heartbeat-check; meta-monitor watches that checker instead.
 */
export const META_MONITOR_EXPECTED_INTERVALS: Readonly<Record<string, number>> = Object.freeze({
  'worker-heartbeat-check': 15,
  'generate-profiles': 720,
  'flash-news-fetch': 60,
  'cleanup-deleted-accounts': 1440,
  'snapshot-ranks': 1440,
  'auto-post-market-summary': 1440,
  'auto-post-twitter': 1440,
  'daily-digest': 1440,
  'subscription-expiry': 1440,
  'reconcile-subscriptions': 1440,
  'stripe-readiness': 1440,
})

export const META_MONITOR_FUTURE_TOLERANCE_MS = 5 * 60_000

/**
 * Find job groups without a successful/partial run inside twice their expected
 * interval. Invalid timestamps are ignored, so a malformed status cannot make
 * a dead job look healthy.
 */
export function findStuckCronJobs(
  statuses: readonly PipelineJobStatus[],
  expectedIntervals: Readonly<Record<string, number>>,
  nowMs = Date.now()
): StuckCronJob[] {
  const lastSuccessByJob = new Map<string, { timestamp: string; timeMs: number }>()

  for (const status of statuses) {
    if (status.status !== 'success' && status.status !== 'partial_success') continue
    const timeMs = Date.parse(status.started_at)
    if (!Number.isFinite(timeMs) || timeMs > nowMs + META_MONITOR_FUTURE_TOLERANCE_MS) continue

    const existing = lastSuccessByJob.get(status.job_name)
    if (!existing || timeMs > existing.timeMs) {
      lastSuccessByJob.set(status.job_name, {
        timestamp: status.started_at,
        timeMs,
      })
    }
  }

  const stuckJobs: StuckCronJob[] = []
  for (const [jobPrefix, expectedMinutes] of Object.entries(expectedIntervals)) {
    let latest: { timestamp: string; timeMs: number } | null = null
    for (const [jobName, success] of lastSuccessByJob) {
      if (jobName !== jobPrefix && !jobName.startsWith(`${jobPrefix}-`)) continue
      if (!latest || success.timeMs > latest.timeMs) latest = success
    }

    if (!latest) {
      stuckJobs.push({
        job: jobPrefix,
        lastSuccess: 'never',
        expectedMinutes,
        actualMinutes: -1,
      })
      continue
    }

    const minutesSince = Math.max(0, (nowMs - latest.timeMs) / 60_000)
    if (minutesSince > expectedMinutes * 2) {
      stuckJobs.push({
        job: jobPrefix,
        lastSuccess: latest.timestamp,
        expectedMinutes,
        actualMinutes: Math.round(minutesSince),
      })
    }
  }

  return stuckJobs
}
