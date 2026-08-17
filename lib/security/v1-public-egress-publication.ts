/**
 * V1 public-egress publication boundary.
 *
 * This browser-safe module is intentionally fixed false in source. Runtime
 * configuration must not reactivate anonymous server-side egress while V1
 * verification is incomplete. It controls only code built from this revision;
 * it does not inspect or change prior deployments, caches, or external hosts.
 */

export const V1_PUBLIC_EGRESS_PUBLISHED = false as const

export const V1_PUBLIC_EGRESS_NOT_PUBLISHED_CODE = 'PUBLIC_EGRESS_NOT_PUBLISHED' as const

export const V1_PUBLIC_EGRESS_UNAVAILABLE_BODY = {
  error: 'Public outbound fetch is temporarily unavailable during V1 verification.',
  code: V1_PUBLIC_EGRESS_NOT_PUBLISHED_CODE,
} as const

export const V1_PUBLIC_EGRESS_NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
} as const

/** Deliberately has no environment override so browser and server agree. */
export function isV1PublicEgressPublished(): boolean {
  return V1_PUBLIC_EGRESS_PUBLISHED
}
