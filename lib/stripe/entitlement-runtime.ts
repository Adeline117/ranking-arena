import 'server-only'

import { PRICING } from '@/app/(app)/user-center/membership-config'
import { STRIPE_PRICE_IDS } from '@/lib/stripe'
import type { StripeAuthorityOptions } from '@/lib/stripe/entitlement-authority'

export function stripeEntitlementAuthorityOptions(
  expectedUserId?: string,
  expectedLivemode?: boolean,
  historicalPrice?: {
    priceId: string
    plan: 'monthly' | 'yearly'
    expectedAmount: number
    currency: string
  }
): StripeAuthorityOptions {
  const monthlyPrices = STRIPE_PRICE_IDS.monthly ? [STRIPE_PRICE_IDS.monthly] : []
  const yearlyPrices = STRIPE_PRICE_IDS.yearly ? [STRIPE_PRICE_IDS.yearly] : []
  if (historicalPrice?.plan === 'monthly' && !monthlyPrices.includes(historicalPrice.priceId)) {
    monthlyPrices.push(historicalPrice.priceId)
  }
  if (historicalPrice?.plan === 'yearly' && !yearlyPrices.includes(historicalPrice.priceId)) {
    yearlyPrices.push(historicalPrice.priceId)
  }
  const expectedRecurringAmountsByPrice: Record<string, number> = {}
  if (STRIPE_PRICE_IDS.monthly) {
    expectedRecurringAmountsByPrice[STRIPE_PRICE_IDS.monthly] = Math.round(
      PRICING.monthly.price * 100
    )
  }
  if (STRIPE_PRICE_IDS.yearly) {
    expectedRecurringAmountsByPrice[STRIPE_PRICE_IDS.yearly] = Math.round(
      PRICING.yearly.price * 100
    )
  }
  if (historicalPrice) {
    expectedRecurringAmountsByPrice[historicalPrice.priceId] = historicalPrice.expectedAmount
  }
  return {
    ...(expectedUserId ? { expectedUserId } : {}),
    ...(typeof expectedLivemode === 'boolean' ? { expectedLivemode } : {}),
    products: {
      prices: {
        monthly: monthlyPrices,
        yearly: yearlyPrices,
        lifetime: STRIPE_PRICE_IDS.lifetime ? [STRIPE_PRICE_IDS.lifetime] : [],
      },
      expectedCurrency: historicalPrice?.currency ?? 'usd',
      expectedRecurringAmountsByPrice,
    },
  }
}
