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
