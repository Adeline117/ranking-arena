/**
 * V1 source-level publication boundary for the ingest command path.
 *
 * This is deliberately a checked-in constant rather than an environment
 * switch: inherited host or container configuration must not be able to
 * reactivate ingestion. It only controls code built from this source; it does
 * not inspect, stop, or prove the state of an existing worker, queue, or
 * external scheduler.
 */
export const V1_INGEST_EXECUTION_PUBLISHED = false as const

export const V1_INGEST_EXECUTION_NOT_PUBLISHED_CODE = 'INGEST_EXECUTION_NOT_PUBLISHED' as const

export function isV1IngestExecutionPublished(): boolean {
  return V1_INGEST_EXECUTION_PUBLISHED
}

/** Throw before a caller can initialize an ingest side effect. */
export function assertV1IngestExecutionPublished(): void {
  if (isV1IngestExecutionPublished()) return

  const error = Object.assign(new Error('V1 ingest execution is not published'), {
    code: V1_INGEST_EXECUTION_NOT_PUBLISHED_CODE,
    name: V1_INGEST_EXECUTION_NOT_PUBLISHED_CODE,
  })
  throw error
}
