const STRIPE_BILLING_PORTAL_HOST = 'billing.stripe.com'

/**
 * Accept only Stripe's first-party Billing Portal origin. The API response is
 * still untrusted input at the browser boundary, even when it normally comes
 * from Stripe through our server.
 */
export function isTrustedStripeBillingPortalUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) return false

  try {
    const url = new URL(value)
    return (
      url.protocol === 'https:' &&
      url.hostname === STRIPE_BILLING_PORTAL_HOST &&
      url.port === '' &&
      url.username === '' &&
      url.password === ''
    )
  } catch {
    return false
  }
}
