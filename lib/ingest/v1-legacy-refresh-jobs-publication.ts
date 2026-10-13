/**
 * V1 publication boundary for the retired legacy `refresh_jobs` pipeline.
 *
 * This is intentionally separate from native ingest execution. It is a
 * checked-in source hold, not an environment switch, and does not inspect or
 * stop a queue, scheduler, or host that was already running before deployment.
 */

export const V1_LEGACY_REFRESH_JOBS_PUBLISHED = false as const

export const V1_LEGACY_REFRESH_JOBS_NOT_PUBLISHED_CODE =
  'LEGACY_REFRESH_JOBS_NOT_PUBLISHED' as const

export const V1_LEGACY_REFRESH_JOBS_NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
} as const

export function isV1LegacyRefreshJobsPublished(): boolean {
  return V1_LEGACY_REFRESH_JOBS_PUBLISHED
}
