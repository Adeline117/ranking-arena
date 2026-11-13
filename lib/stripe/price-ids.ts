/**
 * Pro membership price-ID resolution, shared by every place that maps a Stripe
 * price back to a plan. Dependency-free (no `server-only`, no Stripe SDK) so a
 * route can use it without pulling the whole Stripe module into its graph.
 *
 * Before this module existed, /api/stripe/verify-session recognised only
 * STRIPE_PRO_MONTHLY_PRICE_ID / STRIPE_PRO_YEARLY_PRICE_ID / STRIPE_PRO_PRICE_ID,
 * while checkout and the webhook also accept the STRIPE_PRICE_*_ID and
 * STRIPE_ELITE_PRICE_ID aliases. A deployment that set only an alias could sell
 * a subscription that the success page then rejected as an unknown price.
 */

export type EnvReader = (name: string) => string

const readProcessEnv: EnvReader = (name) => process.env[name]?.trim() || ''

export interface ProPriceIds {
  monthly: string
  yearly: string
  lifetime: string
}

// Falls back to STRIPE_PRO_PRICE_ID for both if specific monthly/yearly IDs not set
export function resolveProPriceIds(read: EnvReader = readProcessEnv): ProPriceIds {
  return {
    monthly:
      read('STRIPE_PRO_MONTHLY_PRICE_ID') ||
      read('STRIPE_PRICE_MONTHLY_ID') ||
      read('STRIPE_PRO_PRICE_ID') ||
      '',
    yearly:
      read('STRIPE_PRO_YEARLY_PRICE_ID') ||
      read('STRIPE_PRICE_YEARLY_ID') ||
      read('STRIPE_ELITE_PRICE_ID') ||
      read('STRIPE_PRO_PRICE_ID') ||
      '',
    lifetime: read('STRIPE_PRO_LIFETIME_PRICE_ID'),
  }
}
