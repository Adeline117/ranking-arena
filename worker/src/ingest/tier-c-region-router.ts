import type { Job } from 'bullmq'
import type { IngestRegion } from '@/lib/ingest/core/regions'
import { assertIngestRegion, tierCQueueName } from '@/lib/ingest/core/tier-c-routing'
import { getSourceBySlug } from '@/lib/ingest/sources'
import { getTierCQueue, INGEST_JOB, type TierCJobData } from './queues'

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

export const MAX_TIER_C_REROUTE_HOPS = 1

type TierCRerouteTarget = Pick<Job<TierCJobData>, 'getState' | 'retry'>

const SAFE_TARGET_STATES = new Set([
  'active',
  'waiting',
  'prioritized',
  'delayed',
  'waiting-children',
  // A retained completion proves this exact target flight already ran.
  'completed',
])

/**
 * A reroute ID identifies the original BullMQ flight, not merely its logical
 * trader request. The original queue + custom job ID + creation timestamp stay
 * stable across attempts of one source job, while a later producer flight or
 * a reverse region move produces a different ID.
 */
export function tierCRerouteJobId(
  job: Pick<Job<TierCJobData>, 'id' | 'timestamp' | 'queueName'>,
  fromRegion: IngestRegion,
  toRegion: IngestRegion
): string {
  const from = assertIngestRegion(fromRegion)
  const to = assertIngestRegion(toRegion)
  if (from === to) throw new Error('[tier-c] reroute requires different regions')
  if (typeof job.id !== 'string' || job.id.length === 0) {
    throw new Error('[tier-c] reroute source job is missing id')
  }
  if (!Number.isSafeInteger(job.timestamp) || job.timestamp <= 0) {
    throw new Error('[tier-c] reroute source job has invalid timestamp')
  }

  const sourceQueue =
    typeof job.queueName === 'string' && job.queueName.length > 0
      ? job.queueName
      : tierCQueueName(from)
  // base64url is an injective encoding of the complete flight tuple and uses
  // no ":" (BullMQ forbids colons in custom IDs). Unlike a truncated hash,
  // this cannot collapse two distinct source flights into one target ID.
  const flight = Buffer.from(
    JSON.stringify([sourceQueue, job.id, job.timestamp, from, to]),
    'utf8'
  ).toString('base64url')
  return `tierc-reroute-v1--${flight}`
}

/**
 * Queue.add() returning is not enough: BullMQ returns an old Job when the
 * custom ID already exists, including a failed Job. Accept only a target that
 * is runnable/in-flight (or demonstrably completed); revive an existing failed
 * instance and verify its state transition before acknowledging the source.
 */
export async function ensureTierCRerouteTarget(
  target: TierCRerouteTarget,
  jobId: string
): Promise<void> {
  let state = await target.getState()
  if (state === 'failed') {
    try {
      await target.retry('failed')
    } catch (error) {
      // Another retry may have won the race. Re-read before declaring failure.
      state = await target.getState()
      if (SAFE_TARGET_STATES.has(state)) return
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(
        `[tier-c] reroute target ${jobId} could not leave failed state (${state}): ${detail}`
      )
    }
    state = await target.getState()
  }

  if (!SAFE_TARGET_STATES.has(state)) {
    throw new Error(`[tier-c] reroute target ${jobId} is not runnable (${state})`)
  }
}

const defaultDeps: TierCRegionRouterDeps = {
  sourceRegion: async (sourceSlug) => (await getSourceBySlug(sourceSlug)).fetch_region,
  enqueue: async (region, data, jobId) => {
    const target = await getTierCQueue(region).add(INGEST_JOB.TIER_C, data, {
      jobId,
      priority: 1,
      removeOnComplete: true,
      removeOnFail: { age: 300 },
    })
    await ensureTierCRerouteTarget(target, jobId)
  },
}

function isLegacyTierCJob(job: Job<TierCJobData>, queueRegion: IngestRegion): boolean {
  const { fetchRegion, tierCRouteToken, tierCRouteHop } = job.data
  if (fetchRegion === undefined) {
    if (tierCRouteToken !== undefined || tierCRouteHop !== undefined) {
      throw new Error('[tier-c] legacy job has incomplete routing metadata')
    }
    return true
  }

  const claimedRegion = assertIngestRegion(fetchRegion)
  if (claimedRegion !== queueRegion) {
    throw new Error(`[tier-c] directed job claims ${claimedRegion} but arrived on ${queueRegion}`)
  }

  const hasToken = tierCRouteToken !== undefined
  const hasHop = tierCRouteHop !== undefined
  if (hasToken !== hasHop) {
    throw new Error('[tier-c] directed job has incomplete routing metadata')
  }
  if (!hasToken) {
    // Current producers and jobs handed off by the first rolling worker build
    // have fetchRegion but no token/hop. They may run only on that exact queue.
    return false
  }

  if (
    typeof tierCRouteToken !== 'string' ||
    !tierCRouteToken.startsWith('tierc-reroute-v1--') ||
    tierCRouteToken !== job.id
  ) {
    throw new Error('[tier-c] rerouted job has invalid routing token')
  }
  if (
    !Number.isSafeInteger(tierCRouteHop) ||
    tierCRouteHop < 1 ||
    tierCRouteHop > MAX_TIER_C_REROUTE_HOPS
  ) {
    throw new Error(`[tier-c] rerouted job exceeds hop limit ${MAX_TIER_C_REROUTE_HOPS}`)
  }
  return false
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

  const isLegacy = isLegacyTierCJob(job, queueRegion)
  const sourceRegion = assertIngestRegion(await deps.sourceRegion(sourceSlug))
  if (sourceRegion === queueRegion) {
    return { action: 'run', region: sourceRegion }
  }

  // Only pre-regionalization jobs are eligible for one compatibility handoff.
  // A producer-directed or already-rerouted job whose DB region changed fails
  // closed; the next request resolves the current region and creates a new
  // flight instead of bouncing an active job between queues.
  if (!isLegacy) {
    throw new Error(
      `[tier-c] directed job on ${queueRegion} no longer matches source region ${sourceRegion}`
    )
  }

  const jobId = tierCRerouteJobId(job, queueRegion, sourceRegion)
  const data: TierCJobData = {
    ...job.data,
    fetchRegion: sourceRegion,
    tierCRouteToken: jobId,
    tierCRouteHop: 1,
  }
  await deps.enqueue(sourceRegion, data, jobId)
  return {
    action: 'rerouted',
    from: queueRegion,
    to: sourceRegion,
    jobId,
  }
}
