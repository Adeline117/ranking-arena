import type { Job } from 'bullmq'

import { isIngestRegion, type IngestRegion } from '@/lib/ingest/core/regions'

import { SOURCE_JOB_LEASE_LANES } from './source-job-routing'
import { createManagedBullJobAuthority, type BullJobAuthority } from './job-provenance'
import type { RegionAuthorityFence, RegionAuthorityLifecycle } from './region-authority-lifecycle'
import { isManagedRegionAuthorityLifecycle } from './region-authority-lifecycle'

export const WORKER_AUTHORITY_REGIONS = ['local', 'vps_sg'] as const
export type WorkerAuthorityRegion = (typeof WORKER_AUTHORITY_REGIONS)[number]

function isWorkerAuthorityRegion(value: unknown): value is WorkerAuthorityRegion {
  return value === 'local' || value === 'vps_sg'
}

/**
 * consumedRegion is the region whose BullMQ queue delivered the job and will
 * select the database authority. executionRegion is the actual browser /
 * network execution location recorded in acquisition provenance. Failover
 * deliberately makes those fields differ.
 */
export interface ConsumedRegionContext {
  readonly consumedRegion: WorkerAuthorityRegion
  readonly executionRegion: IngestRegion
}

export interface AuthorizedConsumedRegionContext extends ConsumedRegionContext {
  readonly authority: RegionAuthorityFence
  assertCanConsume(): void
}

export interface ConsumedRegionAdmission {
  readonly context: AuthorizedConsumedRegionContext
  close(): void
  isOpen(): boolean
  open(): void
}

const AUTHORIZED_CONSUMED_REGION_CONTEXTS = new WeakSet<object>()

class BullMqWaitingError extends Error {
  constructor() {
    super('bullmq:movedToWait')
    this.name = 'WaitingError'
  }
}

function isAuthorizedConsumedRegionContext(
  value: unknown
): value is AuthorizedConsumedRegionContext {
  return (
    value !== null && typeof value === 'object' && AUTHORIZED_CONSUMED_REGION_CONTEXTS.has(value)
  )
}

async function returnJobToWaitOrReject<TJob>(
  job: TJob,
  processorToken: string | undefined,
  message: string
): Promise<never> {
  const candidate = job as { moveToWait?: (token?: string) => Promise<unknown> }
  if (
    typeof processorToken === 'string' &&
    processorToken.length > 0 &&
    typeof candidate?.moveToWait === 'function'
  ) {
    try {
      await candidate.moveToWait.call(job, processorToken)
    } catch {
      throw new Error(`${message} and could not return to wait`)
    }
    throw new BullMqWaitingError()
  }
  throw new Error(message)
}

export function requireWorkerExecutionRegion(value: unknown): IngestRegion {
  if (!isIngestRegion(value)) {
    throw new Error('[ingest-worker] INGEST_LOCAL_REGION must name the execution region')
  }
  return value
}

export function createConsumedRegionContext(
  consumedRegion: string,
  executionRegion: string
): ConsumedRegionContext {
  if (!isWorkerAuthorityRegion(consumedRegion)) {
    throw new Error(`[ingest-worker] unsupported consumed queue region: ${consumedRegion}`)
  }
  return Object.freeze({
    consumedRegion,
    executionRegion: requireWorkerExecutionRegion(executionRegion),
  })
}

/**
 * Build the only production-capable context from an already-active composite
 * lifecycle. Admission starts closed so prepared BullMQ workers cannot process
 * a job before every startup gate has completed.
 */
export function createConsumedRegionAdmission(
  lifecycle: RegionAuthorityLifecycle,
  executionRegion: string
): ConsumedRegionAdmission {
  if (!isManagedRegionAuthorityLifecycle(lifecycle)) {
    throw new Error('[ingest-worker] consumer admission requires a managed authority lifecycle')
  }
  const { fence, region } = lifecycle
  if (
    lifecycle.state !== 'active' ||
    fence.proof.region !== region ||
    fence.proof.authorityScope !== `region:${region}` ||
    !fence.isActive()
  ) {
    throw new Error(`[ingest-worker] ${region} authority is not active for consumer admission`)
  }

  const base = createConsumedRegionContext(region, executionRegion)
  let state: 'closed' | 'open' | 'prepared' = 'prepared'
  const close = () => {
    state = 'closed'
  }
  const context: AuthorizedConsumedRegionContext = Object.freeze({
    ...base,
    authority: fence,
    assertCanConsume: () => {
      if (state !== 'open' || lifecycle.state !== 'active' || !fence.isActive()) {
        throw new Error(`[ingest-worker] ${region} consumer admission is closed`)
      }
    },
  })
  AUTHORIZED_CONSUMED_REGION_CONTEXTS.add(context)
  fence.signal.addEventListener('abort', close, { once: true })

  return Object.freeze({
    close,
    context,
    isOpen: () => state === 'open' && lifecycle.state === 'active' && fence.isActive(),
    open: () => {
      if (state === 'closed') {
        throw new Error(`[ingest-worker] ${region} consumer admission cannot reopen`)
      }
      if (lifecycle.state !== 'active' || !fence.isActive()) {
        throw new Error(`[ingest-worker] ${region} authority is not active for consumer admission`)
      }
      state = 'open'
    },
  })
}

export function bindAuthorizedConsumedRegion<TJob, TResult>(
  context: AuthorizedConsumedRegionContext,
  route: (
    job: TJob,
    context: AuthorizedConsumedRegionContext,
    bullJob: BullJobAuthority,
    signal?: AbortSignal
  ) => Promise<TResult>
): (job: TJob, token?: string, signal?: AbortSignal) => Promise<TResult> {
  if (!isAuthorizedConsumedRegionContext(context)) {
    throw new Error('[ingest-worker] authorized consumer binding requires managed admission')
  }
  // BullMQ 5.77 enables job cancellation only when the processor declares all
  // three parameters. Keep this explicit signature; a rest/default parameter
  // would reduce Function.length and silently disable cancelAllJobs().
  return async (job, processorToken, signal) => {
    try {
      context.assertCanConsume()
    } catch {
      return returnJobToWaitOrReject(
        job,
        processorToken,
        `[ingest-worker] ${context.consumedRegion} consumer admission is closed`
      )
    }
    const jobSignal = signal
      ? AbortSignal.any([context.authority.signal, signal])
      : context.authority.signal
    if (jobSignal.aborted) {
      return returnJobToWaitOrReject(
        job,
        processorToken,
        `[ingest-worker] ${context.consumedRegion} consumer job was cancelled`
      )
    }
    const managedBullJob = createManagedBullJobAuthority(job as object, processorToken, jobSignal)
    try {
      const result = await route(job, context, managedBullJob.authority, jobSignal)
      if (jobSignal.aborted) {
        return returnJobToWaitOrReject(
          job,
          processorToken,
          `[ingest-worker] ${context.consumedRegion} consumer job was cancelled`
        )
      }
      return result
    } catch (error) {
      if (jobSignal.aborted) {
        return returnJobToWaitOrReject(
          job,
          processorToken,
          `[ingest-worker] ${context.consumedRegion} consumer job was cancelled`
        )
      }
      throw error
    } finally {
      managedBullJob.close()
    }
  }
}

export function bindConsumedRegion<
  TJob,
  TResult,
  TContext extends ConsumedRegionContext = ConsumedRegionContext,
>(
  context: TContext,
  route: (job: TJob, context: TContext) => Promise<TResult>
): (job: TJob) => Promise<TResult> {
  if (isAuthorizedConsumedRegionContext(context)) {
    throw new Error('[ingest-worker] authorized consumer context requires authorized binding')
  }
  return (job) => route(job, context)
}

export interface SourceRegionResolver {
  (sourceSlug: string): Promise<IngestRegion>
}

export function assertSourceMatchesConsumedRegion(
  source: { readonly fetch_region: unknown; readonly slug: string },
  context: ConsumedRegionContext
): void {
  // This is the no-I/O fast-fail boundary. Authoritative publishers must also
  // re-check the live source region inside their fenced database transaction;
  // a long crawl can outlive a control-plane source move.
  if (!isIngestRegion(source.fetch_region)) {
    throw new Error(`[ingest-worker] source ${source.slug} has an unsupported fetch region`)
  }
  if (source.fetch_region !== context.consumedRegion) {
    throw new Error(
      `[ingest-worker] source ${source.slug} belongs to ${source.fetch_region}, ` +
        `not consumed queue region ${context.consumedRegion}`
    )
  }
}

/**
 * Scheduled source-wide jobs must still belong to the queue that delivered
 * them. This catches stale jobs after a source moves region, before a browser
 * session, upstream request, RAW write, or serving publication can start.
 */
export async function assertSourceJobMatchesConsumedRegion(
  job: Pick<Job, 'name' | 'data'>,
  context: ConsumedRegionContext,
  resolveSourceRegion: SourceRegionResolver
): Promise<void> {
  if (!Object.prototype.hasOwnProperty.call(SOURCE_JOB_LEASE_LANES, job.name)) return

  const sourceSlug = (job.data as { sourceSlug?: unknown } | undefined)?.sourceSlug
  if (typeof sourceSlug !== 'string' || sourceSlug.trim().length === 0) {
    throw new Error(`[ingest-worker] ${job.name} job is missing sourceSlug`)
  }

  const currentRegion = await resolveSourceRegion(sourceSlug)
  assertSourceMatchesConsumedRegion({ fetch_region: currentRegion, slug: sourceSlug }, context)
}
