import type { Job } from 'bullmq'
import type { IngestRegion } from '@/lib/ingest/core/regions'
import { assertIngestRegion } from '@/lib/ingest/core/tier-c-routing'
import { getSourceBySlug } from '@/lib/ingest/sources'
import { getTierCQueue, INGEST_JOB, tierCJobId, type TierCJobData } from './queues'

export type TierCRegionDecision =
  | { action: 'run'; region: IngestRegion }
  | {
      action: 'rerouted'
      from: IngestRegion
      to: IngestRegion
      jobId: string
    }

export interface TierCRegionRouterDeps {
  sourceRegion(sourceSlug: string): Promise<unknown>
  enqueue(region: IngestRegion, data: TierCJobData, jobId: string): Promise<void>
}

const defaultDeps: TierCRegionRouterDeps = {
  sourceRegion: async (sourceSlug) => (await getSourceBySlug(sourceSlug)).fetch_region,
  enqueue: async (region, data, jobId) => {
    await getTierCQueue(region).add(INGEST_JOB.TIER_C, data, {
      jobId,
      priority: 1,
      removeOnComplete: true,
      removeOnFail: { age: 300 },
    })
  },
}

/**
 * Verify the queue region against the current database source row before any
 * browser or HTTP fetch starts. A legacy/moved-source job is acknowledged only
 * after BullMQ confirms the authoritative target queue accepted it. If that
 * add fails this function throws, so the original job remains retryable.
 */
export async function routeTierCJobRegion(
  job: Job<TierCJobData>,
  consumedRegion: IngestRegion,
  deps: TierCRegionRouterDeps = defaultDeps
): Promise<TierCRegionDecision> {
  const queueRegion = assertIngestRegion(consumedRegion)
  const sourceSlug = job.data?.sourceSlug
  if (typeof sourceSlug !== 'string' || sourceSlug.trim().length === 0) {
    throw new Error('[tier-c] job is missing sourceSlug')
  }

  const sourceRegion = assertIngestRegion(await deps.sourceRegion(sourceSlug))
  if (sourceRegion === queueRegion) {
    return { action: 'run', region: sourceRegion }
  }

  const data: TierCJobData = { ...job.data, fetchRegion: sourceRegion }
  const jobId = tierCJobId(data)
  await deps.enqueue(sourceRegion, data, jobId)
  return {
    action: 'rerouted',
    from: queueRegion,
    to: sourceRegion,
    jobId,
  }
}
