import { INGEST_JOB } from './queues'
import { withSourceJobLease, type SourceJobRedis } from './source-job-lease'

/**
 * Every recurring job that owns one source-wide browser or publication lane.
 * Separate lane names preserve intentional Tier-A/B/D concurrency while
 * collapsing duplicate recovered iterations within the same tier.
 */
export const SOURCE_JOB_LEASE_LANES = {
  [INGEST_JOB.TIER_A]: 'tier-a',
  [INGEST_JOB.TIER_B]: 'tier-b',
  [INGEST_JOB.TIER_B_SERIES]: 'tier-b-series',
  [INGEST_JOB.TIER_D]: 'tier-d',
  [INGEST_JOB.DERIVE_BOARDS]: 'derive',
} as const

/**
 * Framework jobs that must be singleton even when one delayed scheduler
 * iteration starts close to the next scheduled iteration. On-chain enrich can
 * run for hours under provider throttling; without a shared lease, two runs
 * select and rewrite the same wallet batch concurrently.
 */
export const GLOBAL_JOB_LEASE_LANES = {
  [INGEST_JOB.ONCHAIN_ENRICH]: 'onchain-enrich',
} as const

export interface SourceJobLike {
  id?: string
  name: string
  data?: { sourceSlug?: unknown }
}

export interface CoalescedSourceJob {
  coalesced: true
  sourceSlug: string
  lane: string
}

export function sourceJobLeaseLane(jobName: string): string | null {
  return (
    SOURCE_JOB_LEASE_LANES[jobName as keyof typeof SOURCE_JOB_LEASE_LANES] ??
    GLOBAL_JOB_LEASE_LANES[jobName as keyof typeof GLOBAL_JOB_LEASE_LANES] ??
    null
  )
}

/**
 * Wrap the worker dispatcher so duplicate same-source iterations finish
 * immediately instead of becoming BullMQ-active waiters on the same browser
 * profile. Non-source maintenance jobs pass through unchanged.
 */
export async function routeJobWithSourceLease<T>({
  redis,
  job,
  run,
  log = console.log,
}: {
  redis: SourceJobRedis
  job: SourceJobLike
  run: () => Promise<T>
  log?: (message: string) => void
}): Promise<T | CoalescedSourceJob> {
  const lane = sourceJobLeaseLane(job.name)
  if (!lane) return run()

  const isGlobalJob = Object.prototype.hasOwnProperty.call(GLOBAL_JOB_LEASE_LANES, job.name)
  const sourceSlug = isGlobalJob ? 'global' : job.data?.sourceSlug
  if (typeof sourceSlug !== 'string' || sourceSlug.length === 0) {
    throw new Error(`[ingest-worker] ${job.name} job is missing sourceSlug`)
  }

  const result = await withSourceJobLease({ redis, lane, sourceSlug, run })
  if (!result.coalesced) return result.value as T

  log(
    `[ingest-worker] ↪ coalesced duplicate ${job.name} iteration ${job.id ?? 'unknown'} ` +
      `(${sourceSlug})`
  )
  return { coalesced: true, sourceSlug, lane }
}
