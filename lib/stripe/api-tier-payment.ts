import 'server-only'

import type Stripe from 'stripe'
import type { SupabaseClient } from '@supabase/supabase-js'
import { STRIPE_API_PRICE_IDS } from '@/lib/stripe'
import type { Database, Json } from '@/lib/supabase/database.types'
import {
  resolveRecurringInvoiceAuthority,
  StripeAuthorityError,
  type RecurringPaymentAuthority,
} from '@/lib/stripe/entitlement-authority'
import {
  parseApiTierSubscriptionAuthority,
  type ApiTierPlan,
} from '@/app/api/stripe/webhook/handlers/subscription'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const EVENT_ID_PATTERN = /^evt_[A-Za-z0-9_]+$/
const API_METADATA_KEYS = [
  'api_plan',
  'api_tier_reservation_id',
  'supabase_user_id',
  'type',
  'userId',
] as const
const API_PAYMENT_AMOUNTS: Record<ApiTierPlan, number> = {
  starter: 4_900,
  pro: 19_900,
}
const MAX_STRIPE_UNIX_SECONDS = 253_402_300_799

export type ApiTierInvoiceObservation =
  | {
      type: 'invoice.paid' | 'invoice.payment_succeeded'
      id: string
      created: number
      livemode: boolean
    }
  | {
      type: 'historical_backfill'
      id: string
      created: number
      livemode: boolean
    }

export type ApiTierPaymentAuthority = Omit<RecurringPaymentAuthority, 'plan'> & {
  plan: ApiTierPlan
  checkoutReservationId: string
  livemode: boolean
}

export type ApiTierPaymentRecordOutcome = {
  status: 'recorded' | 'already_recorded' | 'identity_conflict' | 'manual_review'
  projectionStatus: string | null
  shouldCancel: boolean
  authority: ApiTierPaymentAuthority
}

function authorityError(params: {
  code: ConstructorParameters<typeof StripeAuthorityError>[0]['code']
  stage: ConstructorParameters<typeof StripeAuthorityError>[0]['stage']
  message: string
  invoiceId: string
  subscriptionId?: string
  customerId?: string
  details?: Record<string, unknown>
}): never {
  throw new StripeAuthorityError({
    code: params.code,
    stage: params.stage,
    message: params.message,
    objectIds: {
      invoiceId: params.invoiceId,
      ...(params.subscriptionId ? { subscriptionId: params.subscriptionId } : {}),
      ...(params.customerId ? { customerId: params.customerId } : {}),
    },
    details: params.details ?? {},
  })
}

function stripeId(value: string | { id: string } | null | undefined): string | null {
  return typeof value === 'string' ? value : (value?.id ?? null)
}

function exactMetadata(
  metadata: Stripe.Metadata | null | undefined,
  expected: {
    userId: string
    plan: ApiTierPlan
    reservationId: string
  }
): boolean {
  const value = metadata ?? {}
  const keys = Object.keys(value).sort()
  return (
    keys.length === API_METADATA_KEYS.length &&
    API_METADATA_KEYS.every((key, index) => keys[index] === key) &&
    value.type === 'api_tier' &&
    value.api_plan === expected.plan &&
    value.userId === expected.userId &&
    value.supabase_user_id === expected.userId &&
    value.api_tier_reservation_id === expected.reservationId
  )
}

function assertObservation(observation: ApiTierInvoiceObservation, invoice: Stripe.Invoice): void {
  const validCommon =
    typeof observation.livemode === 'boolean' &&
    Number.isSafeInteger(observation.created) &&
    observation.created > 0 &&
    observation.created <= MAX_STRIPE_UNIX_SECONDS &&
    observation.created >= invoice.created &&
    invoice.livemode === observation.livemode
  const validId =
    observation.type === 'historical_backfill'
      ? observation.id === `backfill:${String(observation.livemode)}:${invoice.id}`
      : EVENT_ID_PATTERN.test(observation.id) && observation.id.length <= 255

  if (!validCommon || !validId) {
    authorityError({
      code: 'object_mismatch',
      stage: 'invoice',
      message: 'API tier invoice observation context is not exact.',
      invoiceId: invoice.id,
      details: {
        observation,
        invoiceLivemode: invoice.livemode,
        invoiceCreated: invoice.created,
      },
    })
  }
}

function assertExactInvoiceCommercialTerms(invoice: Stripe.Invoice, expectedAmount: number): void {
  const discounts = invoice.discounts
  const totalDiscountAmounts = invoice.total_discount_amounts
  const totalTaxes = invoice.total_taxes
  if (
    invoice.amount_paid !== expectedAmount ||
    invoice.amount_due !== expectedAmount ||
    invoice.subtotal !== expectedAmount ||
    invoice.total !== expectedAmount ||
    invoice.amount_remaining !== 0 ||
    invoice.starting_balance !== 0 ||
    invoice.ending_balance !== 0 ||
    invoice.amount_overpaid !== 0 ||
    !Array.isArray(discounts) ||
    discounts.length !== 0 ||
    !Array.isArray(totalDiscountAmounts) ||
    totalDiscountAmounts.length !== 0 ||
    !Array.isArray(totalTaxes) ||
    totalTaxes.length !== 0
  ) {
    authorityError({
      code: 'amount_mismatch',
      stage: 'invoice',
      message: 'API tier invoice does not match the no-credit, no-discount price contract.',
      invoiceId: invoice.id,
      details: {
        expectedAmount,
        amountPaid: invoice.amount_paid,
        amountDue: invoice.amount_due,
        subtotal: invoice.subtotal,
        total: invoice.total,
        amountRemaining: invoice.amount_remaining,
        startingBalance: invoice.starting_balance,
        endingBalance: invoice.ending_balance,
        amountOverpaid: invoice.amount_overpaid,
        discountCount: Array.isArray(discounts) ? discounts.length : null,
        totalDiscountCount: Array.isArray(totalDiscountAmounts)
          ? totalDiscountAmounts.length
          : null,
        totalTaxCount: Array.isArray(totalTaxes) ? totalTaxes.length : null,
      },
    })
  }
}

/**
 * Re-fetch every Stripe object and resolve one immutable API-tier payment
 * period. The supplied webhook snapshot is used only for its signed event
 * context; no access is granted from stale embedded expansions.
 */
export async function resolveApiTierInvoicePaymentAuthority(params: {
  stripe: Stripe
  invoice: string | Stripe.Invoice
  observation: ApiTierInvoiceObservation
}): Promise<ApiTierPaymentAuthority> {
  const invoiceId = typeof params.invoice === 'string' ? params.invoice : params.invoice.id
  if (!/^in_[A-Za-z0-9_]+$/.test(invoiceId)) {
    authorityError({
      code: 'invalid_object',
      stage: 'invoice',
      message: 'API tier invoice id is malformed.',
      invoiceId,
    })
  }

  const invoice = await params.stripe.invoices.retrieve(invoiceId)
  if (invoice.id !== invoiceId) {
    authorityError({
      code: 'object_mismatch',
      stage: 'invoice',
      message: 'Retrieved API tier invoice id changed.',
      invoiceId,
      details: { retrievedInvoiceId: invoice.id },
    })
  }
  assertObservation(params.observation, invoice)

  const subscriptionDetails = invoice.parent?.subscription_details
  const subscriptionId = stripeId(subscriptionDetails?.subscription)
  if (
    invoice.parent?.type !== 'subscription_details' ||
    !subscriptionDetails ||
    !subscriptionId ||
    !/^sub_[A-Za-z0-9_]+$/.test(subscriptionId)
  ) {
    authorityError({
      code: 'invalid_object',
      stage: 'invoice',
      message: 'Paid API tier invoice has no exact subscription snapshot.',
      invoiceId,
    })
  }

  const subscription = await params.stripe.subscriptions.retrieve(subscriptionId)
  if (subscription.id !== subscriptionId || subscription.livemode !== params.observation.livemode) {
    authorityError({
      code: 'object_mismatch',
      stage: 'subscription',
      message: 'API tier invoice Subscription identity or Stripe mode changed.',
      invoiceId,
      subscriptionId,
      details: {
        retrievedSubscriptionId: subscription.id,
        subscriptionLivemode: subscription.livemode,
        expectedLivemode: params.observation.livemode,
      },
    })
  }

  let apiIdentity: ReturnType<typeof parseApiTierSubscriptionAuthority>
  try {
    apiIdentity = parseApiTierSubscriptionAuthority(subscription, {
      allowHistoricalPriceForNonGrant: true,
    })
  } catch (error) {
    authorityError({
      code: 'identity_invalid',
      stage: 'subscription',
      message: 'API tier Subscription metadata is not exact.',
      invoiceId,
      subscriptionId,
      details: { cause: error instanceof Error ? error.message : String(error) },
    })
  }
  if (!apiIdentity.checkoutReservationId || !UUID_PATTERN.test(apiIdentity.checkoutReservationId)) {
    authorityError({
      code: 'identity_missing',
      stage: 'identity',
      message: 'API tier payment has no durable checkout reservation identity.',
      invoiceId,
      subscriptionId,
      customerId: apiIdentity.stripeCustomerId,
    })
  }
  if (
    !exactMetadata(subscriptionDetails.metadata, {
      userId: apiIdentity.userId,
      plan: apiIdentity.plan,
      reservationId: apiIdentity.checkoutReservationId,
    })
  ) {
    authorityError({
      code: 'identity_conflict',
      stage: 'invoice',
      message: 'API tier Invoice metadata snapshot does not match its Subscription.',
      invoiceId,
      subscriptionId,
      customerId: apiIdentity.stripeCustomerId,
    })
  }

  const starterPrice = STRIPE_API_PRICE_IDS.starter
  const proPrice = STRIPE_API_PRICE_IDS.pro
  if (!starterPrice || !proPrice || starterPrice === proPrice) {
    authorityError({
      code: 'ambiguous_product',
      stage: 'product',
      message: 'API tier Stripe prices are missing or ambiguous.',
      invoiceId,
      subscriptionId,
      details: { starterPrice: starterPrice || null, proPrice: proPrice || null },
    })
  }

  const recurring = await resolveRecurringInvoiceAuthority(params.stripe, invoiceId, {
    expectedUserId: apiIdentity.userId,
    expectedLivemode: params.observation.livemode,
    products: {
      prices: {
        monthly: [starterPrice],
        yearly: [proPrice],
        lifetime: [],
      },
      expectedCurrency: 'usd',
    },
  })
  const resolvedPlan: ApiTierPlan = recurring.plan === 'monthly' ? 'starter' : 'pro'
  const expectedAmount = API_PAYMENT_AMOUNTS[resolvedPlan]
  assertExactInvoiceCommercialTerms(invoice, expectedAmount)

  if (
    resolvedPlan !== apiIdentity.plan ||
    recurring.userId !== apiIdentity.userId ||
    recurring.customerId !== apiIdentity.stripeCustomerId ||
    recurring.subscriptionId !== subscriptionId ||
    recurring.priceId !== apiIdentity.stripePriceId ||
    recurring.amount !== expectedAmount ||
    recurring.currency !== 'usd' ||
    recurring.invoiceCreatedAt !== invoice.created ||
    recurring.paidAt > params.observation.created
  ) {
    authorityError({
      code: 'identity_conflict',
      stage: 'identity',
      message: 'API tier payment chain does not match its sealed subscription identity.',
      invoiceId,
      subscriptionId,
      customerId: apiIdentity.stripeCustomerId,
      details: {
        resolvedPlan,
        expectedPlan: apiIdentity.plan,
        resolvedUserId: recurring.userId,
        expectedUserId: apiIdentity.userId,
        resolvedCustomerId: recurring.customerId,
        expectedCustomerId: apiIdentity.stripeCustomerId,
        resolvedPriceId: recurring.priceId,
        expectedPriceId: apiIdentity.stripePriceId,
        resolvedAmount: recurring.amount,
        expectedAmount,
        paidAt: recurring.paidAt,
        observationCreated: params.observation.created,
      },
    })
  }

  return {
    ...recurring,
    plan: resolvedPlan,
    checkoutReservationId: apiIdentity.checkoutReservationId,
    livemode: params.observation.livemode,
  }
}

function jsonObject(value: Json, operation: string): Record<string, Json | undefined> {
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw new Error(`${operation} returned an invalid result`)
  }
  return value as Record<string, Json | undefined>
}

export async function recordApiTierInvoicePayment(params: {
  supabase: SupabaseClient<Database>
  authority: ApiTierPaymentAuthority
  observation: ApiTierInvoiceObservation
}): Promise<ApiTierPaymentRecordOutcome> {
  const { authority, observation } = params
  const { data, error } = await params.supabase.rpc('record_api_tier_payment_atomic', {
    p_user_id: authority.userId,
    p_livemode: authority.livemode,
    p_stripe_customer_id: authority.customerId,
    p_checkout_reservation_id: authority.checkoutReservationId,
    p_stripe_subscription_id: authority.subscriptionId,
    p_stripe_invoice_id: authority.invoiceId,
    p_stripe_invoice_payment_id: authority.invoicePaymentId,
    p_stripe_payment_intent_id: authority.paymentIntentId,
    p_stripe_charge_id: authority.chargeId,
    p_stripe_price_id: authority.priceId,
    p_api_plan: authority.plan,
    p_amount_paid: authority.amount,
    p_currency: authority.currency,
    p_period_start: authority.periodStart,
    p_period_end: authority.periodEnd,
    p_invoice_created: authority.invoiceCreatedAt,
    p_paid_at: authority.paidAt,
    p_observation_id: observation.id,
    p_observation_created: observation.created,
    p_observation_type: observation.type,
  })
  if (error) {
    throw new Error(`Failed to persist API tier invoice payment: ${error.message}`)
  }

  const result = jsonObject(data, 'record_api_tier_payment_atomic')
  const status = result.status
  if (
    status !== 'recorded' &&
    status !== 'already_recorded' &&
    status !== 'identity_conflict' &&
    status !== 'manual_review'
  ) {
    throw new Error(
      `record_api_tier_payment_atomic returned unexpected status ${String(status ?? 'missing')}`
    )
  }

  return {
    status,
    projectionStatus:
      typeof result.projection_status === 'string' ? result.projection_status : null,
    shouldCancel: result.should_cancel === true,
    authority,
  }
}
