/**
 * V1 referral-program publication boundary.
 *
 * This browser-safe module is an immutable checked-in source hold. Runtime
 * configuration must not reactivate referral attribution while its qualifying
 * execution path remains unavailable.
 */

export const V1_REFERRAL_PROGRAM_PUBLISHED = false as const

export const V1_REFERRAL_PROGRAM_NOT_PUBLISHED_CODE = 'REFERRAL_PROGRAM_NOT_PUBLISHED' as const

export const V1_REFERRAL_PROGRAM_UNAVAILABLE_BODY = {
  error: 'Referral program is temporarily unavailable during V1 verification.',
  code: V1_REFERRAL_PROGRAM_NOT_PUBLISHED_CODE,
} as const

export const V1_REFERRAL_PROGRAM_NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
} as const

/** Deliberately has no environment override so browser and server agree. */
export function isV1ReferralProgramPublished(): boolean {
  return V1_REFERRAL_PROGRAM_PUBLISHED
}
