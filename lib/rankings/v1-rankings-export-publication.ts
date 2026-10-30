/**
 * V1 direct rankings-export publication boundary.
 *
 * This checked-in source hold applies only to the arbitrary service-auth
 * `/api/export/rankings` ingress. It deliberately has no environment override:
 * reopening the export command requires a separately reviewed source change.
 * It does not inspect, stop, or prove the state of the V3 CSV endpoint,
 * authenticated user-data exports, a deployed route, or an external caller.
 */

export const V1_RANKINGS_EXPORT_PUBLISHED = false as const

export const V1_RANKINGS_EXPORT_NOT_PUBLISHED_CODE = 'RANKINGS_EXPORT_NOT_PUBLISHED' as const

export const V1_RANKINGS_EXPORT_UNAVAILABLE_BODY = {
  error: 'Rankings export is temporarily unavailable during V1 verification.',
  code: V1_RANKINGS_EXPORT_NOT_PUBLISHED_CODE,
} as const

export const V1_RANKINGS_EXPORT_NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
} as const

/** Deliberately has no environment override. */
export function isV1RankingsExportPublished(): boolean {
  return V1_RANKINGS_EXPORT_PUBLISHED
}
