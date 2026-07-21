import { NextRequest } from 'next/server'
import type Stripe from 'stripe'
import { withCron } from '@/lib/api/with-cron'
import { sendRateLimitedAlert } from '@/lib/alerts/send-alert'
import {
  assertApiPriceReady,
  assertProPriceReady,
  getStripe,
  STRIPE_API_PRICE_IDS,
  STRIPE_PRICE_IDS,
} from '@/lib/stripe'
import { STRIPE_API_VERSION } from '@/lib/stripe/version'

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
  'refund.created',
  'refund.updated',
  'refund.failed',
  'charge.dispute.created',
] as const

const ENTITLEMENT_READINESS_METRIC_KEYS = [
  'open_manual_reviews',
  'unfinished_effects',
  'completed_effects_without_external_ref',
  'paid_unbound_payments',
  'unresolved_refund_tombstones',
  'reservation_anomalies',
  'projection_drift',
  'notification_delivery_anomalies',
  'authority_drift',
] as const

export const STRIPE_PAID_READINESS_KEYS = ['status', ...ENTITLEMENT_READINESS_METRIC_KEYS] as const

type EntitlementReadinessMetric = (typeof ENTITLEMENT_READINESS_METRIC_KEYS)[number]

type StripePaidReadiness = {
  status: 'ready' | 'blocked'
} & Record<EntitlementReadinessMetric, number>

const WEBHOOK_URL = 'https://www.arenafi.org/api/stripe/webhook'
const MAX_WEBHOOK_ENDPOINT_PAGES = 100

async function listEnabledCanonicalWebhookEndpoints(): Promise<Stripe.WebhookEndpoint[]> {
  const stripe = getStripe()
  const enabled: Stripe.WebhookEndpoint[] = []
  const seenCursors = new Set<string>()
  let startingAfter: string | undefined

  for (let pageIndex = 0; pageIndex < MAX_WEBHOOK_ENDPOINT_PAGES; pageIndex += 1) {
    const page = await stripe.webhookEndpoints.list({
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    })
    enabled.push(
      ...page.data.filter(
        (endpoint) => endpoint.url === WEBHOOK_URL && endpoint.status === 'enabled'
      )
    )
    if (!page.has_more) return enabled

    const nextCursor = page.data.at(-1)?.id
    if (!nextCursor || seenCursors.has(nextCursor)) {
      throw new Error('Stripe webhook endpoint pagination did not advance')
    }
    seenCursors.add(nextCursor)
    startingAfter = nextCursor
  }

  throw new Error('Stripe webhook endpoint pagination exceeded the safety limit')
}

function keyMode(value: string | undefined, livePrefix: string, testPrefix: string) {
  if (value?.startsWith(livePrefix)) return 'live'
  if (value?.startsWith(testPrefix)) return 'test'
  return 'invalid'
}

function parseStripePaidReadiness(value: unknown): StripePaidReadiness | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null

  const record = value as Record<string, unknown>
  const actualKeys = Object.keys(record).sort()
  const expectedKeys = [...STRIPE_PAID_READINESS_KEYS].sort()
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    return null
  }
  if (record.status !== 'ready' && record.status !== 'blocked') return null
  for (const key of ENTITLEMENT_READINESS_METRIC_KEYS) {
    if (!Number.isSafeInteger(record[key]) || (record[key] as number) < 0) return null
  }

  return {
    status: record.status,
    open_manual_reviews: record.open_manual_reviews as number,
    unfinished_effects: record.unfinished_effects as number,
    completed_effects_without_external_ref: record.completed_effects_without_external_ref as number,
    paid_unbound_payments: record.paid_unbound_payments as number,
    unresolved_refund_tombstones: record.unresolved_refund_tombstones as number,
    reservation_anomalies: record.reservation_anomalies as number,
    projection_drift: record.projection_drift as number,
    notification_delivery_anomalies: record.notification_delivery_anomalies as number,
    authority_drift: record.authority_drift as number,
  }
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
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET?.trim() || ''
    const webhookSecretConfigured = webhookSecret.startsWith('whsec_')
    const previousWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET_PREVIOUS?.trim() || ''
    const previousWebhookSecretConfigured = previousWebhookSecret.length > 0
    const previousWebhookSecretValid = previousWebhookSecret.startsWith('whsec_')
    const webhookSecretsDistinct = previousWebhookSecret !== webhookSecret

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
    if (previousWebhookSecretConfigured && !previousWebhookSecretValid) {
      failures.push('Previous Stripe webhook signing secret is invalid')
    }
    if (previousWebhookSecretValid && !webhookSecretsDistinct) {
      failures.push('Previous Stripe webhook signing secret must differ from primary')
    }
    if (!promoEnabled && secretMode !== 'live') {
      failures.push('Production paywall is enabled without live Stripe keys')
    }
    if (promoEnabled) warnings.push('Owner gate remains: free promo is enabled')
    if (secretMode === 'test') warnings.push('Owner gate remains: Stripe is in test mode')
    if (previousWebhookSecretValid && webhookSecretsDistinct) {
      warnings.push('Cutover gate remains: previous Stripe webhook signing secret is configured')
    }

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
      const enabled = await listEnabledCanonicalWebhookEndpoints()
      const expectedEvents = new Set<string>(REQUIRED_WEBHOOK_EVENTS)
      const exactContract =
        enabled.length === 1 &&
        enabled[0].api_version === STRIPE_API_VERSION &&
        enabled[0].enabled_events.length === expectedEvents.size &&
        new Set(enabled[0].enabled_events).size === expectedEvents.size &&
        enabled[0].enabled_events.every((event) => expectedEvents.has(event))
      if (!exactContract) {
        failures.push('Enabled Stripe webhook endpoint or event contract has drifted')
      }
    } catch (_error) {
      failures.push('Stripe webhook endpoint verification failed')
    }

    const staleCutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString()
    const [failedEvents, staleEvents, paidReadinessResult] = await Promise.all([
      supabase
        .from('stripe_events')
        .select('event_id', { count: 'exact', head: true })
        .eq('status', 'failed'),
      supabase
        .from('stripe_events')
        .select('event_id', { count: 'exact', head: true })
        .eq('status', 'processing')
        .lt('started_at', staleCutoff),
      supabase.rpc('stripe_paid_launch_readiness_v2'),
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

    let entitlementReadiness: StripePaidReadiness | null = null
    if (paidReadinessResult.error) {
      failures.push('Stripe entitlement authority readiness query failed')
    } else {
      const parsedReadiness = parseStripePaidReadiness(paidReadinessResult.data)
      entitlementReadiness = parsedReadiness
      if (!parsedReadiness) {
        failures.push('Stripe entitlement authority readiness contract is invalid')
      } else if (parsedReadiness.status !== 'ready') {
        const blockedMetrics = ENTITLEMENT_READINESS_METRIC_KEYS.filter(
          (key) => parsedReadiness[key] !== 0
        ).map((key) => `${key}=${parsedReadiness[key]}`)
        failures.push(
          `Stripe entitlement authority is blocked${
            blockedMetrics.length > 0 ? `: ${blockedMetrics.join(', ')}` : ''
          }`
        )
      }
    }

    const paidLaunchReady =
      failures.length === 0 &&
      !promoEnabled &&
      secretMode === 'live' &&
      publishableMode === 'live' &&
      !previousWebhookSecretConfigured

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
      entitlementReadiness,
      failures,
      warnings,
    }
  },
  { safetyTimeoutMs: 55_000 }
)
