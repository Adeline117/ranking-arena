/**
 * Page for an arena-worker job that exhausted its retries (2026-11 audit
 * P1-7). The BullMQ 'failed' event used to only console.error, so a
 * permanently failing Meilisearch sync (or any future job) was invisible.
 * Routed through the same ingest alert path as publication refusals.
 *
 * Season publication jobs are excluded: publishLeaderboardSeason already
 * pages `season_publication_refused` for every failed attempt, so paging the
 * final failure again would duplicate the same incident.
 */

import type { IngestAlert } from '../../lib/ingest/alerting'

export interface FailedJobView {
  name: string
  attemptsMade: number
  opts: { attempts?: number }
  data: unknown
}

export function finalJobFailureAlert(
  job: FailedJobView | undefined,
  error: Error,
  alreadyAlertedJobNames: ReadonlySet<string>
): Omit<IngestAlert, 'at'> | null {
  if (!job || alreadyAlertedJobNames.has(job.name)) return null
  const maxAttempts = job.opts.attempts ?? 1
  if (job.attemptsMade < maxAttempts) return null // BullMQ will retry
  return {
    sourceSlug: `arena-worker:${job.name}`,
    phase: 0,
    tier: 'A',
    message: `job ${job.name} failed after ${job.attemptsMade}/${maxAttempts} attempts: ${error.message.slice(0, 300)}`,
  }
}
