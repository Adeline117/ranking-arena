/**
 * V1 publication boundary for trader alerts.
 *
 * This is intentionally a source constant, not an environment toggle: reopening
 * an alerting product requires a separately reviewed release with a verified
 * scheduler, delivery path, and customer-facing contract.
 */
export const TRADER_ALERTS_PUBLISHED = false as const
export const TRADER_ALERTS_NOT_PUBLISHED_CODE = 'TRADER_ALERTS_NOT_PUBLISHED' as const
export const TRADER_NOTIFICATION_NOT_PUBLISHED_CODE = 'TRADER_NOTIFICATIONS_NOT_PUBLISHED' as const

export const TRADER_ALERTS_NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
} as const

export const TRADER_ALERTS_UNAVAILABLE_MESSAGE =
  'Trader alerts are temporarily unavailable during V1 verification.'

export const TRADER_NOTIFICATION_UNAVAILABLE_MESSAGE =
  'Trader alerts, ranking-change notifications, and personalized digests are temporarily unavailable during V1 verification.'
