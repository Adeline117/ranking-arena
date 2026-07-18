import type Stripe from 'stripe'

export function stripeObjectId(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) return value
  if (
    value &&
    typeof value === 'object' &&
    'id' in value &&
    typeof value.id === 'string' &&
    value.id.length > 0
  ) {
    return value.id
  }
  return null
}

export function stripeMetadataUserId(
  metadata: Stripe.Metadata | null | undefined,
  source: string
): string | null {
  if (!metadata) return null
  const candidates = [metadata.supabase_user_id, metadata.userId, metadata.user_id].filter(
    (value): value is string => typeof value === 'string' && value.length > 0
  )
  if (new Set(candidates).size > 1) {
    throw new Error(`${source} has conflicting user identities`)
  }
  return candidates[0] ?? null
}

export function assertStripeSubscriptionIdentity(
  subscription: Stripe.Subscription,
  expected: {
    subscriptionId: string
    customerId: string
    userId: string
    source: string
  }
): void {
  if (subscription.id !== expected.subscriptionId) {
    throw new Error(`${expected.source} resolved to a different Stripe subscription`)
  }

  const customerId = stripeObjectId(subscription.customer)
  if (!customerId || customerId !== expected.customerId) {
    throw new Error(`${expected.source} resolved to a different Stripe customer`)
  }

  const metadataUserId = stripeMetadataUserId(
    subscription.metadata,
    `Stripe subscription ${subscription.id}`
  )
  if (metadataUserId && metadataUserId !== expected.userId) {
    throw new Error(`${expected.source} resolved to a different user`)
  }
}

export function assertStripePaymentIdentity(
  paymentIntent: Stripe.PaymentIntent,
  charge: Stripe.Charge,
  expected: {
    paymentIntentId: string
    customerId: string
    source: string
  }
): void {
  if (paymentIntent.id !== expected.paymentIntentId) {
    throw new Error(`${expected.source} resolved to a different PaymentIntent`)
  }

  const paymentIntentCustomerId = stripeObjectId(paymentIntent.customer)
  if (!paymentIntentCustomerId || paymentIntentCustomerId !== expected.customerId) {
    throw new Error(`${expected.source} PaymentIntent has a different Stripe customer`)
  }

  const chargePaymentIntentId = stripeObjectId(charge.payment_intent)
  if (!chargePaymentIntentId || chargePaymentIntentId !== expected.paymentIntentId) {
    throw new Error(`${expected.source} charge has a different PaymentIntent`)
  }

  const chargeCustomerId = stripeObjectId(charge.customer)
  if (!chargeCustomerId || chargeCustomerId !== expected.customerId) {
    throw new Error(`${expected.source} charge has a different Stripe customer`)
  }
}
