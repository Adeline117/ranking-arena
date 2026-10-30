/**
 * V1 direct admin billing-reconciliation publication boundary.
 *
 * This checked-in source hold applies only to the direct administrator
 * subscription-sync command. It deliberately has no environment override:
 * reopening that command requires a separately reviewed source change. It
 * does not inspect, stop, or prove the state of Stripe webhooks, checkout,
 * the customer portal, scheduled reconciliation, or an older deployment.
 */

export const V1_BILLING_RECONCILIATION_PUBLISHED = false as const

export const V1_BILLING_RECONCILIATION_NOT_PUBLISHED_CODE =
  'BILLING_RECONCILIATION_NOT_PUBLISHED' as const

export const V1_BILLING_RECONCILIATION_UNAVAILABLE_BODY = {
  error:
    'Administrative subscription reconciliation is temporarily unavailable during V1 verification.',
  code: V1_BILLING_RECONCILIATION_NOT_PUBLISHED_CODE,
} as const

export const V1_BILLING_RECONCILIATION_NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
} as const

/** Deliberately has no environment override. */
export function isV1BillingReconciliationPublished(): boolean {
  return V1_BILLING_RECONCILIATION_PUBLISHED
}
