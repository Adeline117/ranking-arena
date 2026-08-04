/**
 * Canonical pricing source — imported by PricingPageClient, lib/stripe, etc.
 * Change prices here and they propagate everywhere.
 */
export const PRICING = {
  monthly: { price: 4.99, original: null as number | null },
  yearly: { price: 29.99, original: 59.88 },
  lifetime: { price: 49.99, spots: 200 },
}

// B2B Data API pricing (separate from Pro membership)
export const API_PRICING = {
  starter: { price: 49, dailyLimit: 10_000 },
  pro: { price: 199, dailyLimit: 0 }, // 0 = unlimited
}
