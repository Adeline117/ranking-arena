import type Stripe from 'stripe'

export type ProPlan = 'monthly' | 'yearly'

export type ActiveProSubscription = {
  kind: 'active'
  plan: ProPlan
  subscription: Stripe.Subscription
}

export type ProSubscriptionClassification =
  | ActiveProSubscription
  | { kind: 'none' }
  | { kind: 'unknown-active-price'; priceIds: string[] }

type PriceIds = {
  monthly: string
  yearly: string
  apiStarter?: string
  apiPro?: string
}

export function getProPlan(priceId: string | undefined, priceIds: PriceIds): ProPlan | null {
  if (priceId && priceIds.monthly && priceId === priceIds.monthly) return 'monthly'
  if (priceId && priceIds.yearly && priceId === priceIds.yearly) return 'yearly'
  return null
}

/**
 * Classify Stripe's current recurring entitlement without trusting the local DB.
 * Unknown active prices are deliberately inconclusive: they must never grant a
 * new entitlement, but an automated repair job must not revoke an existing one
 * until an operator fixes or confirms the price mapping.
 */
export function classifyActiveProSubscription(
  subscriptions: Stripe.Subscription[],
  priceIds: PriceIds
): ProSubscriptionClassification {
  const active = subscriptions.filter(
    (subscription) => subscription.status === 'active' || subscription.status === 'trialing'
  )

  for (const subscription of active) {
    const priceId = subscription.items.data[0]?.price.id
    const plan = getProPlan(priceId, priceIds)
    if (plan) return { kind: 'active', plan, subscription }
  }

  const knownApiPrices = new Set([priceIds.apiStarter, priceIds.apiPro].filter(Boolean))
  const unknownPriceIds = active
    .map((subscription) => subscription.items.data[0]?.price.id)
    .filter((priceId): priceId is string => Boolean(priceId) && !knownApiPrices.has(priceId))

  if (unknownPriceIds.length > 0) {
    return { kind: 'unknown-active-price', priceIds: [...new Set(unknownPriceIds)] }
  }

  return { kind: 'none' }
}
