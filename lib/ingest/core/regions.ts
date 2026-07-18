import type { FetchRegion } from './types'

/**
 * The database CHECK constraint and every queue router must share one region
 * allowlist. Unknown values are rejected instead of silently creating an
 * unconsumed queue.
 */
export const INGEST_REGIONS = [
  'local',
  'vps_sg',
  'vps_jp',
] as const satisfies readonly FetchRegion[]

export type IngestRegion = (typeof INGEST_REGIONS)[number]

export function isIngestRegion(value: unknown): value is IngestRegion {
  return typeof value === 'string' && (INGEST_REGIONS as readonly string[]).includes(value)
}
