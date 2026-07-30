const STRIPE_BILLING_PORTAL_HOST = 'billing.stripe.com'
const STRIPE_CHECKOUT_HOST = 'checkout.stripe.com'

function isTrustedStripeHostedUrl(value: unknown, expectedHost: string): value is string {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) return false

  try {
    const url = new URL(value)
    return (
      url.protocol === 'https:' &&
      url.hostname === expectedHost &&
      url.port === '' &&
      url.username === '' &&
      url.password === ''
    )
  } catch {
    return false
  }
}

/**
 * Accept only Stripe's first-party Billing Portal origin. The API response is
 * still untrusted input at the browser boundary, even when it normally comes
 * from Stripe through our server.
 */
export function isTrustedStripeBillingPortalUrl(value: unknown): value is string {
  return isTrustedStripeHostedUrl(value, STRIPE_BILLING_PORTAL_HOST)
}

/** Accept only Stripe's first-party hosted Checkout origin. */
export function isTrustedStripeCheckoutUrl(value: unknown): value is string {
  return isTrustedStripeHostedUrl(value, STRIPE_CHECKOUT_HOST)
}
