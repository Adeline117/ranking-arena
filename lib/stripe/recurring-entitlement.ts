import 'server-only'

import type Stripe from 'stripe'
import type { SupabaseClient } from '@supabase/supabase-js'
import { PRICING } from '@/app/(app)/user-center/membership-config'
import type { Database, Json } from '@/lib/supabase/database.types'
import {
  resolveRecurringInvoiceAuthority,
  StripeAuthorityError,
  type RecurringPaymentAuthority,
} from '@/lib/stripe/entitlement-authority'
import { stripeEntitlementAuthorityOptions } from '@/lib/stripe/entitlement-runtime'

const SAFE_RECURRING_ACTIVATION_STATUSES = new Set([
  'activated',
  'already_activated',
  'current_entitlement_protected',
  'identity_conflict',
  'manual_review',
  'parallel_subscription_review',
  'refunded_payment',
  'stale_payment',
  'stripe_status_not_entitling',
  'subject_deleted',
] as const)
const PRO_SUBSCRIPTION_METADATA_KEYS = [
  'plan',
  'pro_checkout_nonce',
  'pro_checkout_operation_id',
  'pro_checkout_reservation_id',
  'stripe_customer_id',
  'stripe_price_id',
  'supabase_user_id',
  'trial_requested',
  'type',
  'userId',
] as const
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export type SafeRecurringActivationStatus =
  | 'activated'
  | 'already_activated'
  | 'current_entitlement_protected'
  | 'identity_conflict'
  | 'manual_review'
  | 'parallel_subscription_review'
  | 'refunded_payment'
  | 'stale_payment'
  | 'stripe_status_not_entitling'
  | 'subject_deleted'

export type RecurringActivationOutcome = {
  status: SafeRecurringActivationStatus
  authority: RecurringPaymentAuthority
}

function rpcStatus(value: Json, operation: string): string {
  if (
    !value ||
    Array.isArray(value) ||
    typeof value !== 'object' ||
    typeof value.status !== 'string'
  ) {
    throw new Error(`${operation} returned an invalid result`)
  }
  return value.status
}

function expectedAmount(plan: RecurringPaymentAuthority['plan']): number {
  return Math.round(PRICING[plan].price * 100)
}

async function assertCompletedCheckoutReservation(params: {
  stripe: Stripe
  supabase: SupabaseClient<Database>
  authority: RecurringPaymentAuthority
  livemode: boolean
}): Promise<void> {
  const subscription = await params.stripe.subscriptions.retrieve(params.authority.subscriptionId)
  const metadata = subscription.metadata ?? {}
  const keys = Object.keys(metadata).sort()
  const trialRequested =
    metadata.trial_requested === 'true' ? true : metadata.trial_requested === 'false' ? false : null
  const reservationId = metadata.pro_checkout_reservation_id
  const operationId = metadata.pro_checkout_operation_id
  const reservationNonce = metadata.pro_checkout_nonce
  if (
    subscription.id !== params.authority.subscriptionId ||
    subscription.livemode !== params.livemode ||
    keys.length !== PRO_SUBSCRIPTION_METADATA_KEYS.length ||
    !PRO_SUBSCRIPTION_METADATA_KEYS.every((key, index) => keys[index] === key) ||
    metadata.type !== 'pro_subscription' ||
    metadata.userId !== params.authority.userId ||
    metadata.supabase_user_id !== params.authority.userId ||
    metadata.stripe_customer_id !== params.authority.customerId ||
    metadata.stripe_price_id !== params.authority.priceId ||
    metadata.plan !== params.authority.plan ||
    !reservationId ||
    !UUID_PATTERN.test(reservationId) ||
    !operationId ||
    !UUID_PATTERN.test(operationId) ||
    !reservationNonce ||
    !UUID_PATTERN.test(reservationNonce) ||
    trialRequested === null
  ) {
    throw new StripeAuthorityError({
      code: 'identity_conflict',
      stage: 'subscription',
      message: 'Recurring Pro Subscription has no exact completed-checkout identity.',
      objectIds: {
        customerId: params.authority.customerId,
        subscriptionId: params.authority.subscriptionId,
        invoiceId: params.authority.invoiceId,
      },
      details: {
        metadataKeys: keys,
        subscriptionLivemode: subscription.livemode,
        expectedLivemode: params.livemode,
      },
    })
  }

  const { data, error } = await params.supabase.rpc(
    'assert_recurring_pro_checkout_completed_atomic',
    {
      p_user_id: params.authority.userId,
      p_livemode: params.livemode,
      p_stripe_customer_id: params.authority.customerId,
      p_stripe_subscription_id: params.authority.subscriptionId,
      p_reservation_id: reservationId,
      p_operation_id: operationId,
      p_reservation_nonce: reservationNonce,
      p_plan: params.authority.plan,
      p_stripe_price_id: params.authority.priceId,
      p_trial_requested: trialRequested,
    }
  )
  if (error) {
    throw new Error(`Recurring Pro checkout completion is not ready: ${error.message}`)
  }
  if (data !== 'completed') {
    throw new Error(
      `assert_recurring_pro_checkout_completed_atomic returned ${String(data ?? 'missing')}`
    )
  }
}

export async function activateRecurringInvoiceEntitlement(params: {
  stripe: Stripe
  supabase: SupabaseClient<Database>
  invoice: string | Stripe.Invoice
  livemode: boolean
}): Promise<RecurringActivationOutcome> {
  const authority = await resolveRecurringInvoiceAuthority(params.stripe, params.invoice, {
    ...stripeEntitlementAuthorityOptions(),
    expectedLivemode: params.livemode,
  })
  const amount = expectedAmount(authority.plan)
  if (authority.amount !== amount || authority.currency !== 'usd') {
    throw new StripeAuthorityError({
      code: authority.amount !== amount ? 'amount_mismatch' : 'currency_mismatch',
      stage: 'product',
      message: 'Recurring Pro payment does not match its configured price contract.',
      objectIds: {
        customerId: authority.customerId,
        subscriptionId: authority.subscriptionId,
        invoiceId: authority.invoiceId,
        invoicePaymentId: authority.invoicePaymentId,
        paymentIntentId: authority.paymentIntentId ?? undefined,
        chargeId: authority.chargeId,
      },
      details: {
        plan: authority.plan,
        expectedAmount: amount,
        actualAmount: authority.amount,
        expectedCurrency: 'usd',
        actualCurrency: authority.currency,
      },
    })
  }

  await assertCompletedCheckoutReservation({
    stripe: params.stripe,
    supabase: params.supabase,
    authority,
    livemode: params.livemode,
  })

  const { data, error } = await params.supabase.rpc(
    'activate_recurring_entitlement_payment_atomic',
    {
      p_user_id: authority.userId,
      p_stripe_customer_id: authority.customerId,
      p_stripe_subscription_id: authority.subscriptionId,
      p_stripe_invoice_id: authority.invoiceId,
      p_stripe_payment_intent_id: authority.paymentIntentId,
      p_stripe_charge_id: authority.chargeId,
      p_plan: authority.plan,
      p_amount_paid: authority.amount,
      p_currency: authority.currency,
      p_period_start: new Date(authority.periodStart * 1000).toISOString(),
      p_period_end: new Date(authority.periodEnd * 1000).toISOString(),
      p_payment_status: 'paid',
      p_stripe_subscription_status: authority.subscriptionStatus,
    }
  )
  if (error) {
    throw new Error(`Failed to activate recurring Pro payment: ${error.message}`)
  }
  const status = rpcStatus(data, 'activate_recurring_entitlement_payment_atomic')
  if (!SAFE_RECURRING_ACTIVATION_STATUSES.has(status as SafeRecurringActivationStatus)) {
    throw new Error(
      `activate_recurring_entitlement_payment_atomic returned unsafe status ${status}`
    )
  }

  return {
    status: status as SafeRecurringActivationStatus,
    authority,
  }
}
