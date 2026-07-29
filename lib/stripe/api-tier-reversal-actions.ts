import 'server-only'

import { randomUUID } from 'node:crypto'
import type Stripe from 'stripe'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getStripe } from '@/lib/stripe'
import type { Database, Json } from '@/lib/supabase/database.types'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { createLogger } from '@/lib/utils/logger'
import { parseApiTierSubscriptionAuthority } from '@/app/api/stripe/webhook/handlers/subscription'
import { parseRecurringProCheckoutMetadata } from '@/lib/stripe/recurring-pro-checkout'

const logger = createLogger('api-tier-reversal-actions')
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const CUSTOMER_ID_PATTERN = /^cus_[A-Za-z0-9_]+$/
const SUBSCRIPTION_ID_PATTERN = /^sub_[A-Za-z0-9_]+$/

type ReversalAction = {
  id: string
  ownershipId: string
  productKind: 'api_tier' | 'pro_entitlement'
  livemode: boolean
  userId: string
  customerId: string
  subscriptionId: string
  attempts: number
  leaseToken: string
}

export type ApiTierReversalDrainSummary = {
  claimed: number
  completed: number
  retried: number
}

function objectValue(value: Json): Record<string, Json | undefined> | null {
  return value && !Array.isArray(value) && typeof value === 'object'
    ? (value as Record<string, Json | undefined>)
    : null
}

function parseAction(value: Json, expectedToken: string): ReversalAction {
  const row = objectValue(value)
  const id = row?.id
  const ownershipId = row?.ownership_id
  const rawProductKind = row?.product_kind
  const productKind = rawProductKind === undefined ? 'api_tier' : rawProductKind
  const livemode = row?.livemode
  const userId = row?.user_id
  const customerId = row?.stripe_customer_id
  const subscriptionId = row?.stripe_subscription_id
  const attempts = row?.attempts
  const leaseToken = row?.lease_token
  if (
    typeof id !== 'string' ||
    !UUID_PATTERN.test(id) ||
    typeof ownershipId !== 'string' ||
    !UUID_PATTERN.test(ownershipId) ||
    (productKind !== 'api_tier' && productKind !== 'pro_entitlement') ||
    typeof livemode !== 'boolean' ||
    typeof userId !== 'string' ||
    !UUID_PATTERN.test(userId) ||
    typeof customerId !== 'string' ||
    !CUSTOMER_ID_PATTERN.test(customerId) ||
    typeof subscriptionId !== 'string' ||
    !SUBSCRIPTION_ID_PATTERN.test(subscriptionId) ||
    typeof attempts !== 'number' ||
    !Number.isSafeInteger(attempts) ||
    attempts < 1 ||
    typeof leaseToken !== 'string' ||
    leaseToken !== expectedToken
  ) {
    throw new Error('claim_api_tier_reversal_actions_atomic returned malformed action identity')
  }
  return {
    id,
    ownershipId,
    productKind,
    livemode,
    userId: userId.toLowerCase(),
    customerId,
    subscriptionId,
    attempts,
    leaseToken,
  }
}

function configuredLivemode(): boolean {
  const secret = process.env.STRIPE_SECRET_KEY?.trim() ?? ''
  if (secret.startsWith('sk_live_')) return true
  if (secret.startsWith('sk_test_')) return false
  throw new Error('STRIPE_SECRET_KEY has no exact live/test mode')
}

function stripeCustomerId(
  value: string | Stripe.Customer | Stripe.DeletedCustomer | null
): string | null {
  return typeof value === 'string' ? value : (value?.id ?? null)
}

function resourceMissing(error: unknown): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: unknown }).code === 'resource_missing'
  )
}

async function finishAction(params: {
  supabase: SupabaseClient<Database>
  action: ReversalAction
  succeeded: boolean
  disposition?: 'canceled' | 'already_canceled' | 'resource_missing'
  error?: string
}): Promise<void> {
  const retryAfterSeconds = Math.min(
    86_400,
    Math.max(5, 30 * 2 ** Math.min(params.action.attempts - 1, 11))
  )
  const { data, error } = await params.supabase.rpc('finish_api_tier_reversal_action_atomic', {
    p_action_id: params.action.id,
    p_lease_token: params.action.leaseToken,
    p_succeeded: params.succeeded,
    p_disposition: params.disposition ?? null,
    p_error: params.error?.slice(0, 2_000) ?? null,
    p_retry_after_seconds: params.succeeded ? null : retryAfterSeconds,
  })
  if (error) {
    throw new Error(`Failed to finish API tier reversal action: ${error.message}`)
  }
  const accepted = params.succeeded
    ? new Set(['completed', 'already_completed'])
    : new Set(['retry_scheduled'])
  if (typeof data !== 'string' || !accepted.has(data)) {
    throw new Error(
      `finish_api_tier_reversal_action_atomic returned unexpected status ${String(
        data ?? 'missing'
      )}`
    )
  }
}

async function executeAction(params: {
  stripe: Stripe
  supabase: SupabaseClient<Database>
  action: ReversalAction
}): Promise<'completed' | 'retried'> {
  const { stripe, supabase, action } = params
  let subscription: Stripe.Subscription
  try {
    subscription = await stripe.subscriptions.retrieve(action.subscriptionId)
  } catch (error) {
    if (resourceMissing(error)) {
      await finishAction({
        supabase,
        action,
        succeeded: true,
        disposition: 'resource_missing',
      })
      return 'completed'
    }
    const message = error instanceof Error ? error.message : String(error)
    await finishAction({ supabase, action, succeeded: false, error: message })
    return 'retried'
  }

  try {
    const customerId = stripeCustomerId(subscription.customer)
    const authorityMatches =
      action.productKind === 'api_tier'
        ? (() => {
            const authority = parseApiTierSubscriptionAuthority(subscription, {
              allowHistoricalPriceForNonGrant: true,
            })
            return (
              authority.userId === action.userId && authority.stripeCustomerId === action.customerId
            )
          })()
        : (() => {
            const authority = parseRecurringProCheckoutMetadata(subscription.metadata)
            return authority?.userId === action.userId && authority.customerId === action.customerId
          })()
    if (
      subscription.id !== action.subscriptionId ||
      subscription.livemode !== action.livemode ||
      customerId !== action.customerId ||
      !authorityMatches
    ) {
      throw new Error('Fresh Stripe subscription does not match reversal action identity')
    }

    if (subscription.status === 'canceled') {
      await finishAction({
        supabase,
        action,
        succeeded: true,
        disposition: 'already_canceled',
      })
      return 'completed'
    }

    const canceled = await stripe.subscriptions.cancel(action.subscriptionId)
    if (
      canceled.id !== action.subscriptionId ||
      canceled.livemode !== action.livemode ||
      stripeCustomerId(canceled.customer) !== action.customerId ||
      canceled.status !== 'canceled'
    ) {
      throw new Error('Stripe cancellation response does not match reversal action identity')
    }
    await finishAction({
      supabase,
      action,
      succeeded: true,
      disposition: 'canceled',
    })
    return 'completed'
  } catch (error) {
    if (resourceMissing(error)) {
      await finishAction({
        supabase,
        action,
        succeeded: true,
        disposition: 'resource_missing',
      })
      return 'completed'
    }
    const message = error instanceof Error ? error.message : String(error)
    logger.error('Stripe subscription reversal cancellation will retry', {
      actionId: action.id,
      productKind: action.productKind,
      subscriptionId: action.subscriptionId,
      attempts: action.attempts,
      error: message,
    })
    await finishAction({ supabase, action, succeeded: false, error: message })
    return 'retried'
  }
}

export async function drainApiTierReversalActions(
  params: {
    stripe?: Stripe
    supabase?: SupabaseClient<Database>
    limit?: number
  } = {}
): Promise<ApiTierReversalDrainSummary> {
  const stripe = params.stripe ?? getStripe()
  const supabase = params.supabase ?? (getSupabaseAdmin() as SupabaseClient<Database>)
  const limit = params.limit ?? 10
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error('API tier reversal action limit is invalid')
  }
  const livemode = configuredLivemode()
  const workerToken = randomUUID()
  const { data, error } = await supabase.rpc('claim_api_tier_reversal_actions_atomic', {
    p_worker_token: workerToken,
    p_limit: limit,
    p_lease_seconds: 120,
    p_livemode: livemode,
  })
  if (error) {
    throw new Error(`Failed to claim API tier reversal actions: ${error.message}`)
  }
  if (!Array.isArray(data)) {
    throw new Error('claim_api_tier_reversal_actions_atomic returned an invalid result')
  }
  const actions = data.map((value) => parseAction(value, workerToken))
  let completed = 0
  let retried = 0
  for (const action of actions) {
    const outcome = await executeAction({ stripe, supabase, action })
    if (outcome === 'completed') completed += 1
    else retried += 1
  }
  return { claimed: actions.length, completed, retried }
}

export function currentStripeLivemode(): boolean {
  return configuredLivemode()
}
