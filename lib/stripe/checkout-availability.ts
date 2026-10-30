/**
 * Lifetime one-time checkout stays closed in Production until the owner flips
 * STRIPE_LIFETIME_CHECKOUT_ENABLED. Shared by the create-checkout route (which
 * answers 503 LIFETIME_CHECKOUT_UNAVAILABLE) and the pricing page (which renders
 * the lifetime CTA as "coming soon" instead of leading into that 503).
 */
export function isLifetimeCheckoutEnabled(): boolean {
  return (
    process.env.VERCEL_ENV !== 'production' ||
    process.env.STRIPE_LIFETIME_CHECKOUT_ENABLED === 'true'
  )
}
