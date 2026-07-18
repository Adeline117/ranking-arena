export type PricingBilling = 'monthly' | 'yearly'
export type PricingPlanIntent = 'free' | 'pro' | 'trial' | 'lifetime'

export function parsePricingBilling(value: string | null | undefined): PricingBilling | null {
  return value === 'monthly' || value === 'yearly' ? value : null
}

export function buildPricingReturnPath(plan: PricingPlanIntent, billing: PricingBilling): string {
  const params = new URLSearchParams({ plan, billing })
  return `/pricing?${params.toString()}`
}

export function buildPricingLoginHref(plan: PricingPlanIntent, billing: PricingBilling): string {
  return `/login?returnUrl=${encodeURIComponent(buildPricingReturnPath(plan, billing))}`
}
