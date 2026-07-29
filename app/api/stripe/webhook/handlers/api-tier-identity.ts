import type Stripe from 'stripe'
import { getApiPlanFromPriceId } from './stripe-price-identity'

export const API_TIER_RESERVATION_METADATA_KEY = 'api_tier_reservation_id'

export function hasOwnMetadataKey(metadata: Stripe.Metadata, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(metadata, key)
}

export function carriesApiTierSubscriptionIdentity(subscription: Stripe.Subscription): boolean {
  const metadata = subscription.metadata || {}

  return (
    metadata.type === 'api_tier' ||
    hasOwnMetadataKey(metadata, 'api_plan') ||
    hasOwnMetadataKey(metadata, API_TIER_RESERVATION_METADATA_KEY) ||
    (subscription.items?.data || []).some((item) => getApiPlanFromPriceId(item.price.id) !== null)
  )
}
