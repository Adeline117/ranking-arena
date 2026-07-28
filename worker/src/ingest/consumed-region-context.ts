import type { Job } from 'bullmq'

import { isIngestRegion, type IngestRegion } from '@/lib/ingest/core/regions'

import { SOURCE_JOB_LEASE_LANES } from './source-job-routing'

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

export function bindConsumedRegion<TJob, TResult>(
  context: ConsumedRegionContext,
  route: (job: TJob, context: ConsumedRegionContext) => Promise<TResult>
): (job: TJob) => Promise<TResult> {
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
