import type { Job } from 'bullmq'

/**
 * Stable identity for one scheduler-fired observation cycle.
 *
 * BullMQ keeps `job.id` and `job.timestamp` stable across attempts. Never use
 * attemptsMade here: retries are re-observations of the same scheduled cycle,
 * not independent evidence for count-baseline or level-shift decisions.
 */
export function observationCycleId(
  job: Pick<Job, 'id' | 'timestamp'>,
  kind: string,
  sourceSlug: string
): string | null {
  const jobId = typeof job.id === 'string' && job.id.length > 0 ? job.id : null
  const timestamp =
    typeof job.timestamp === 'number' && Number.isFinite(job.timestamp)
      ? String(job.timestamp)
      : null
  if (timestamp === null) return null

  // Some recovery jobs deliberately reuse one fixed BullMQ id after the
  // prior instance is removed. The creation timestamp distinguishes those
  // genuinely independent jobs while remaining stable across retries.
  return `${kind}:${sourceSlug}:${jobId ?? 'anonymous'}:${timestamp}`
}
