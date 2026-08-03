import { STRIPE_API_PRICE_IDS, STRIPE_PRICE_IDS } from '@/lib/stripe'

export type ApiTierPlan = 'starter' | 'pro'
export type ProPlan = 'monthly' | 'yearly' | 'lifetime'

export function getApiPlanFromPriceId(priceId: string | undefined): ApiTierPlan | null {
  if (!priceId) return null
  if (STRIPE_API_PRICE_IDS?.starter && priceId === STRIPE_API_PRICE_IDS.starter) {
    return 'starter'
  }
  if (STRIPE_API_PRICE_IDS?.pro && priceId === STRIPE_API_PRICE_IDS.pro) return 'pro'
  return null
}

export function getProPlanFromPriceId(priceId: string | undefined): ProPlan | null {
  if (!priceId) return null
  if (STRIPE_PRICE_IDS?.yearly && priceId === STRIPE_PRICE_IDS.yearly) return 'yearly'
  if (STRIPE_PRICE_IDS?.lifetime && priceId === STRIPE_PRICE_IDS.lifetime) {
    return 'lifetime'
  }
  if (STRIPE_PRICE_IDS?.monthly && priceId === STRIPE_PRICE_IDS.monthly) {
    return 'monthly'
  }
  return null
}
