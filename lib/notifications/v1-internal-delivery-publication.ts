/**
 * V1 direct internal-notification-delivery publication boundary.
 *
 * This checked-in source hold applies only to the direct
 * `/api/notifications/send` service ingress. It deliberately has no
 * environment override: reopening arbitrary service delivery requires a
 * separately reviewed source change. It does not inspect, stop, or prove the
 * state of in-process notification helpers, Stripe/group flows, historical
 * notification rows, or an older deployment.
 */

export const V1_INTERNAL_NOTIFICATION_DELIVERY_PUBLISHED = false as const

export const V1_INTERNAL_NOTIFICATION_DELIVERY_NOT_PUBLISHED_CODE =
  'INTERNAL_NOTIFICATION_DELIVERY_NOT_PUBLISHED' as const

export const V1_INTERNAL_NOTIFICATION_DELIVERY_UNAVAILABLE_BODY = {
  error: 'Internal notification delivery is temporarily unavailable during V1 verification.',
  code: V1_INTERNAL_NOTIFICATION_DELIVERY_NOT_PUBLISHED_CODE,
} as const

export const V1_INTERNAL_NOTIFICATION_DELIVERY_NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
} as const

/** Deliberately has no environment override. */
export function isV1InternalNotificationDeliveryPublished(): boolean {
  return V1_INTERNAL_NOTIFICATION_DELIVERY_PUBLISHED
}
