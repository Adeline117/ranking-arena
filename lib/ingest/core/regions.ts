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

/**
 * An omitted INGEST_REGIONS keeps the historical single-node default. Once an
 * operator explicitly sets the variable, every comma-separated value must be
 * present, known, and unique; empty/typo entries abort startup.
 */
export function parseIngestRegionsEnv(
  raw: string | undefined,
  options: { requireExplicit?: boolean } = {}
): IngestRegion[] {
  if (raw === undefined) {
    if (options.requireExplicit) {
      throw new Error('[ingest] INGEST_REGIONS is required for managed or production workers')
    }
    return [...INGEST_REGIONS]
  }

  const values = raw.split(',').map((value) => value.trim())
  if (values.length === 0 || values.some((value) => value.length === 0)) {
    throw new Error('[ingest] INGEST_REGIONS must not be empty')
  }

  const unknown = values.filter((value) => !isIngestRegion(value))
  if (unknown.length > 0) {
    throw new Error(`[ingest] INGEST_REGIONS contains unsupported region(s): ${unknown.join(',')}`)
  }

  if (new Set(values).size !== values.length) {
    throw new Error('[ingest] INGEST_REGIONS must not contain duplicates')
  }

  return values as IngestRegion[]
}
