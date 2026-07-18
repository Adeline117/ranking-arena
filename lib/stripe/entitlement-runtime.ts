import 'server-only'

import { STRIPE_PRICE_IDS } from '@/lib/stripe'
import type { StripeAuthorityOptions } from '@/lib/stripe/entitlement-authority'

export function stripeEntitlementAuthorityOptions(expectedUserId?: string): StripeAuthorityOptions {
  return {
    ...(expectedUserId ? { expectedUserId } : {}),
    products: {
      prices: {
        monthly: STRIPE_PRICE_IDS.monthly ? [STRIPE_PRICE_IDS.monthly] : [],
        yearly: STRIPE_PRICE_IDS.yearly ? [STRIPE_PRICE_IDS.yearly] : [],
        lifetime: STRIPE_PRICE_IDS.lifetime ? [STRIPE_PRICE_IDS.lifetime] : [],
      },
      expectedCurrency: 'usd',
    },
  }
}
