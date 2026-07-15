import { NextRequest } from 'next/server'
import { withCron } from '@/lib/api/with-cron'
import { sendRateLimitedAlert } from '@/lib/alerts/send-alert'
import {
  assertApiPriceReady,
  assertProPriceReady,
  getStripe,
  STRIPE_API_PRICE_IDS,
  STRIPE_PRICE_IDS,
} from '@/lib/stripe'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export const REQUIRED_WEBHOOK_EVENTS = [
  'checkout.session.completed',
  'checkout.session.expired',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'customer.subscription.trial_will_end',
  'invoice.paid',
  'invoice.payment_succeeded',
  'invoice.payment_failed',
  'invoice.payment_action_required',
  'invoice.finalization_failed',
  'charge.refunded',
  'charge.refund.updated',
  'refund.updated',
  'charge.dispute.created',
] as const

const WEBHOOK_URL = 'https://www.arenafi.org/api/stripe/webhook'

function keyMode(value: string | undefined, livePrefix: string, testPrefix: string) {
  if (value?.startsWith(livePrefix)) return 'live'
  if (value?.startsWith(testPrefix)) return 'test'
  return 'invalid'
}

export const GET = withCron(
  'stripe-readiness',
  async (_request: NextRequest, { supabase }) => {
    const failures: string[] = []
    const warnings: string[] = []
    const secretMode = keyMode(process.env.STRIPE_SECRET_KEY, 'sk_live_', 'sk_test_')
    const publishableMode = keyMode(
      process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY,
      'pk_live_',
      'pk_test_'
    )
    const promoEnabled = process.env.NEXT_PUBLIC_PRO_FREE_PROMO !== 'false'
    const webhookSecretConfigured = process.env.STRIPE_WEBHOOK_SECRET?.startsWith('whsec_') === true

    if (secretMode === 'invalid') failures.push('Stripe secret key is missing or invalid')
    if (publishableMode === 'invalid') failures.push('Stripe publishable key is missing or invalid')
    if (
      secretMode !== 'invalid' &&
      publishableMode !== 'invalid' &&
      secretMode !== publishableMode
    ) {
      failures.push('Stripe secret and publishable key modes do not match')
    }
    if (!webhookSecretConfigured)
      failures.push('Stripe webhook signing secret is missing or invalid')
    if (!promoEnabled && secretMode !== 'live') {
      failures.push('Production paywall is enabled without live Stripe keys')
    }
    if (promoEnabled) warnings.push('Owner gate remains: free promo is enabled')
    if (secretMode === 'test') warnings.push('Owner gate remains: Stripe is in test mode')

    const proPriceChecks = await Promise.allSettled([
      assertProPriceReady('monthly', STRIPE_PRICE_IDS.monthly),
      assertProPriceReady('yearly', STRIPE_PRICE_IDS.yearly),
      assertProPriceReady('lifetime', STRIPE_PRICE_IDS.lifetime),
    ])
    const proPlans = ['monthly', 'yearly', 'lifetime'] as const
    for (const [index, result] of proPriceChecks.entries()) {
      if (result.status === 'rejected') {
        failures.push(`B2C ${proPlans[index]} price contract failed`)
      }
    }

    const apiPriceChecks = await Promise.allSettled([
      assertApiPriceReady('starter', STRIPE_API_PRICE_IDS.starter),
      assertApiPriceReady('pro', STRIPE_API_PRICE_IDS.pro),
    ])
    const apiPlans = ['starter', 'pro'] as const
    for (const [index, result] of apiPriceChecks.entries()) {
      if (result.status === 'rejected') {
        warnings.push(`Secondary API ${apiPlans[index]} price contract failed`)
      }
    }

    try {
      const endpoints = await getStripe().webhookEndpoints.list({ limit: 100 })
      const enabled = endpoints.data.filter(
        (endpoint) => endpoint.url === WEBHOOK_URL && endpoint.status === 'enabled'
      )
      const expectedEvents = new Set<string>(REQUIRED_WEBHOOK_EVENTS)
      const exactContract =
        enabled.length === 1 &&
        enabled[0].enabled_events.length === expectedEvents.size &&
        enabled[0].enabled_events.every((event) => expectedEvents.has(event))
      if (!exactContract) {
        failures.push('Enabled Stripe webhook endpoint or event contract has drifted')
      }
    } catch (_error) {
      failures.push('Stripe webhook endpoint verification failed')
    }

    const staleCutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString()
    const [failedEvents, staleEvents] = await Promise.all([
      supabase
        .from('stripe_events')
        .select('event_id', { count: 'exact', head: true })
        .eq('status', 'failed'),
      supabase
        .from('stripe_events')
        .select('event_id', { count: 'exact', head: true })
        .eq('status', 'processing')
        .lt('started_at', staleCutoff),
    ])
    if (failedEvents.error || staleEvents.error) {
      failures.push('Stripe webhook event health query failed')
    } else {
      if ((failedEvents.count || 0) > 0) {
        failures.push(`${failedEvents.count} Stripe webhook event(s) are failed`)
      }
      if ((staleEvents.count || 0) > 0) {
        failures.push(`${staleEvents.count} Stripe webhook event(s) are stuck processing`)
      }
    }

    const paidLaunchReady =
      failures.length === 0 && !promoEnabled && secretMode === 'live' && publishableMode === 'live'

    if (failures.length > 0) {
      await sendRateLimitedAlert(
        {
          title: 'Stripe production readiness failed',
          message: failures.join('\n'),
          level: 'critical',
          details: { failureCount: failures.length, warningCount: warnings.length },
        },
        `stripe-readiness:${failures.sort().join('|')}`,
        6 * 60 * 60 * 1000
      )
    }

    return {
      count: failures.length,
      healthy: failures.length === 0,
      paidLaunchReady,
      mode: secretMode,
      promoEnabled,
      failures,
      warnings,
    }
  },
  { safetyTimeoutMs: 55_000 }
)
