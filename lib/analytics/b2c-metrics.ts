import type { Json } from '@/lib/supabase/database.types'

export const B2C_FUNNEL_STEPS = [
  'landing_view',
  'ranking_visible',
  'view_trader',
  'signup_start',
  'signup',
  'onboarding_complete',
  'view_pricing',
  'start_checkout',
  'pro_subscribe',
] as const

export type B2CFunnelStep = (typeof B2C_FUNNEL_STEPS)[number]

export interface B2CProductMetrics {
  windowDays: number
  wau: number
  totalPaying: number
  newPaying: number
  newSignups: number
  activationEligible: number
  activated7d: number
  funnel: Partial<Record<B2CFunnelStep, number>>
  eventCollectionStartedAt: string | null
  generatedAt: string
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null
}

export function parseB2CProductMetrics(value: Json | null): B2CProductMetrics | null {
  if (!value || Array.isArray(value) || typeof value !== 'object') return null

  const windowDays = nonNegativeInteger(value.window_days)
  const wau = nonNegativeInteger(value.wau)
  const totalPaying = nonNegativeInteger(value.total_paying)
  const newPaying = nonNegativeInteger(value.new_paying)
  const newSignups = nonNegativeInteger(value.new_signups)
  const activationEligible = nonNegativeInteger(value.activation_eligible)
  const activated7d = nonNegativeInteger(value.activated_7d)
  const generatedAt = value.generated_at
  const collectionStartedAt = value.event_collection_started_at

  if (
    windowDays === null ||
    wau === null ||
    totalPaying === null ||
    newPaying === null ||
    newSignups === null ||
    activationEligible === null ||
    activated7d === null ||
    typeof generatedAt !== 'string' ||
    (collectionStartedAt !== null && typeof collectionStartedAt !== 'string')
  ) {
    return null
  }

  const rawFunnel = value.funnel
  if (!rawFunnel || Array.isArray(rawFunnel) || typeof rawFunnel !== 'object') return null
  const funnel: Partial<Record<B2CFunnelStep, number>> = {}
  for (const step of B2C_FUNNEL_STEPS) {
    const count = rawFunnel[step]
    if (count !== undefined) {
      const parsed = nonNegativeInteger(count)
      if (parsed === null) return null
      funnel[step] = parsed
    }
  }

  return {
    windowDays,
    wau,
    totalPaying,
    newPaying,
    newSignups,
    activationEligible,
    activated7d,
    funnel,
    eventCollectionStartedAt: collectionStartedAt,
    generatedAt,
  }
}
