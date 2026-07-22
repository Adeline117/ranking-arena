import 'server-only'

import type Stripe from 'stripe'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database, Json } from '@/lib/supabase/database.types'
import {
  StripeAuthorityError,
  type StripeAuthorityErrorCode,
  type StripeAuthorityErrorStage,
  type StripeAuthorityObjectIds,
} from '@/lib/stripe/entitlement-authority'
import { recordStripeCheckoutManualReview } from '@/lib/stripe/lifetime-entitlement'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const STRIPE_TIMESTAMP_MAX_SECONDS = 253_402_300_799
const TIP_METADATA_KEYS = [
  'amount_cents',
  'from_user_id',
  'post_id',
  'tip_id',
  'to_user_id',
  'type',
  'user_id',
] as const

const terminalStatuses = new Set([
  'completed',
  'already_completed',
  'refunded',
  'identity_conflict',
  'manual_review',
  'notification_suppressed',
] as const)

export type TipCompletionStatus =
  | 'completed'
  | 'already_completed'
  | 'refunded'
  | 'identity_conflict'
  | 'manual_review'
  | 'notification_suppressed'

export type TipPaymentAuthority = {
  tipId: string
  clientReferenceId: string | null
  metadataUserId: string
  metadataFromUserId: string
  metadataPostId: string
  metadataToUserId: string
  metadataAmountCents: number
  sessionId: string
  checkoutExpiresAt: string
  customerId: string
  paymentIntentId: string
  chargeId: string
  amount: number
  currency: string
  completedAt: string
  refundSucceededAmount: number
  fullyRefunded: boolean
}

export type TipCompletionOutcome = {
  status: TipCompletionStatus
  authority?: TipPaymentAuthority
  reviewCode?: StripeAuthorityErrorCode
  result?: Json
}

function authorityError(
  code: StripeAuthorityErrorCode,
  stage: StripeAuthorityErrorStage,
  message: string,
  objectIds: StripeAuthorityObjectIds,
  details: Record<string, unknown> = {}
): never {
  throw new StripeAuthorityError({ code, stage, message, objectIds, details })
}

function isStripeResourceMissing(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const candidate = error as {
    code?: unknown
    statusCode?: unknown
    type?: unknown
    name?: unknown
  }
  return (
    candidate.code === 'resource_missing' &&
    (candidate.statusCode === 404 ||
      (candidate.statusCode == null &&
        (candidate.type === 'StripeInvalidRequestError' ||
          candidate.name === 'StripeInvalidRequestError')))
  )
}

async function retrieveExactStripeObject<T>(params: {
  operation: () => Promise<T>
  stage: StripeAuthorityErrorStage
  label: string
  objectId: string
  objectIds: StripeAuthorityObjectIds
}): Promise<T> {
  try {
    return await params.operation()
  } catch (error) {
    if (isStripeResourceMissing(error)) {
      authorityError(
        'resource_missing',
        params.stage,
        `The exact Stripe ${params.label} is missing from the configured account and mode.`,
        params.objectIds,
        {
          missing_object: params.label,
          missing_object_id: params.objectId,
          stripe_error_code: 'resource_missing',
        }
      )
    }
    throw error
  }
}

function stripeId(
  value: string | { id: string } | null | undefined,
  prefix: string,
  stage: StripeAuthorityErrorStage,
  label: string,
  objectIds: StripeAuthorityObjectIds
): string {
  const candidate = typeof value === 'string' ? value : value?.id
  if (
    !candidate ||
    candidate.trim() !== candidate ||
    candidate.length > 255 ||
    !candidate.startsWith(prefix) ||
    !/^[A-Za-z0-9_]+$/.test(candidate)
  ) {
    authorityError('invalid_object', stage, `${label} is missing or malformed.`, objectIds, {
      label,
      value: candidate || null,
      expected_prefix: prefix,
    })
  }
  return candidate
}

function assertObject(
  value: unknown,
  expectedObject: string,
  stage: StripeAuthorityErrorStage,
  objectIds: StripeAuthorityObjectIds
): asserts value is Record<string, unknown> {
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    authorityError(
      'invalid_object',
      stage,
      `Stripe ${expectedObject} response is malformed.`,
      objectIds
    )
  }
  if ((value as { object?: unknown }).object !== expectedObject) {
    authorityError(
      'invalid_object',
      stage,
      `Stripe ${expectedObject} object type does not match.`,
      objectIds,
      {
        expected_object: expectedObject,
        actual_object: (value as { object?: unknown }).object ?? null,
      }
    )
  }
}

function assertExactId(
  actual: string,
  expected: string,
  stage: StripeAuthorityErrorStage,
  label: string,
  objectIds: StripeAuthorityObjectIds
): void {
  if (actual !== expected) {
    authorityError('object_mismatch', stage, `${label} does not match.`, objectIds, {
      label,
      expected,
      actual,
    })
  }
}

function exactPositiveAmount(
  value: number | null | undefined,
  source: string,
  objectIds: StripeAuthorityObjectIds
): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    authorityError(
      'amount_mismatch',
      'product',
      'Tip payment amount is missing or unsafe.',
      objectIds,
      {
        source,
        value: value ?? null,
      }
    )
  }
  return value as number
}

function exactZeroAmount(
  value: number | null | undefined,
  source: string,
  objectIds: StripeAuthorityObjectIds
): void {
  if (!Number.isSafeInteger(value) || value !== 0) {
    authorityError(
      'amount_mismatch',
      'product',
      'Tip checkout includes an unexpected adjustment.',
      objectIds,
      {
        source,
        value: value ?? null,
      }
    )
  }
}

function exactCurrency(
  value: string | null | undefined,
  source: string,
  objectIds: StripeAuthorityObjectIds
): string {
  if (!value || !/^[a-z]{3}$/.test(value)) {
    authorityError(
      'currency_mismatch',
      'product',
      'Tip payment currency is missing or malformed.',
      objectIds,
      {
        source,
        value: value ?? null,
      }
    )
  }
  return value
}

function assertAllEqual<T>(
  values: Array<{ source: string; value: T }>,
  code: 'amount_mismatch' | 'currency_mismatch',
  objectIds: StripeAuthorityObjectIds
): T {
  const distinct = [...new Set(values.map(({ value }) => value))]
  if (distinct.length !== 1) {
    authorityError(
      code,
      'product',
      `Tip payment ${code === 'amount_mismatch' ? 'amounts' : 'currencies'} do not match.`,
      objectIds,
      {
        values,
      }
    )
  }
  return distinct[0]
}

function canonicalMetadataUuid(
  value: string | null | undefined,
  label: string,
  objectIds: StripeAuthorityObjectIds
): string {
  if (!value) {
    authorityError(
      'identity_missing',
      'identity',
      `Tip checkout metadata is missing ${label}.`,
      objectIds,
      { field: label }
    )
  }
  if (!UUID_PATTERN.test(value)) {
    authorityError(
      'identity_invalid',
      'identity',
      `Tip checkout metadata ${label} is not a canonical UUID.`,
      objectIds,
      {
        field: label,
        value,
      }
    )
  }
  return value
}

function exactStripeTimestamp(
  value: number | null | undefined,
  stage: StripeAuthorityErrorStage,
  label: string,
  objectIds: StripeAuthorityObjectIds
): string {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) <= 0 ||
    (value as number) > STRIPE_TIMESTAMP_MAX_SECONDS
  ) {
    authorityError('invalid_object', stage, `${label} is missing or unsafe.`, objectIds, {
      [label]: value ?? null,
    })
  }
  return new Date((value as number) * 1000).toISOString()
}

function isEmptyOptionalStripeCollection(value: unknown): boolean {
  return value == null || (Array.isArray(value) && value.length === 0)
}

function authoritativeCompletedAt(
  created: number | null | undefined,
  objectIds: StripeAuthorityObjectIds
): string {
  return exactStripeTimestamp(created, 'charge', 'charge_created', objectIds)
}

function stableReviewObjectId(sessionId: unknown, eventId: unknown): string {
  if (
    typeof sessionId === 'string' &&
    sessionId.startsWith('cs_') &&
    sessionId.trim() === sessionId &&
    sessionId.length > 3 &&
    sessionId.length <= 255
  ) {
    return sessionId
  }
  if (
    typeof eventId === 'string' &&
    eventId.startsWith('evt_') &&
    eventId.trim() === eventId &&
    eventId.length > 4 &&
    eventId.length <= 255
  ) {
    return eventId
  }
  throw new Error('Tip checkout has no immutable Stripe identity for durable review')
}

function reviewContext(error: StripeAuthorityError, eventId: string): Json {
  return JSON.parse(
    JSON.stringify({ ...error.toReviewPayload(), event_id: eventId || null })
  ) as Json
}

async function resolveTipPaymentAuthority(
  stripe: Stripe,
  sessionId: string
): Promise<TipPaymentAuthority> {
  const objectIds: StripeAuthorityObjectIds = { sessionId }
  const requestedSessionId = stripeId(
    sessionId,
    'cs_',
    'checkout_session',
    'checkout session id',
    objectIds
  )

  const session = await retrieveExactStripeObject({
    operation: () => stripe.checkout.sessions.retrieve(requestedSessionId),
    stage: 'checkout_session',
    label: 'Checkout Session',
    objectId: requestedSessionId,
    objectIds,
  })
  assertObject(session, 'checkout.session', 'checkout_session', objectIds)
  const freshSessionId = stripeId(
    session.id,
    'cs_',
    'checkout_session',
    'checkout session.id',
    objectIds
  )
  assertExactId(
    freshSessionId,
    requestedSessionId,
    'checkout_session',
    'checkout session.id',
    objectIds
  )

  if (
    session.mode !== 'payment' ||
    session.status !== 'complete' ||
    session.payment_status !== 'paid' ||
    session.metadata?.type !== 'tip' ||
    session.subscription !== null
  ) {
    authorityError(
      'invalid_session_state',
      'checkout_session',
      'Checkout Session is not an exact completed tip payment.',
      objectIds,
      {
        mode: session.mode ?? null,
        status: session.status ?? null,
        payment_status: session.payment_status ?? null,
        metadata_type: session.metadata?.type ?? null,
        subscription_present: session.subscription !== null,
      }
    )
  }

  const metadata = session.metadata ?? {}
  const metadataKeys = Object.keys(metadata).sort()
  const tipId = canonicalMetadataUuid(metadata.tip_id, 'tip_id', objectIds)
  const metadataUserId = canonicalMetadataUuid(metadata.user_id, 'user_id', objectIds)
  const metadataFromUserId = canonicalMetadataUuid(metadata.from_user_id, 'from_user_id', objectIds)
  const metadataPostId = canonicalMetadataUuid(metadata.post_id, 'post_id', objectIds)
  const metadataToUserId = canonicalMetadataUuid(metadata.to_user_id, 'to_user_id', objectIds)
  if (
    metadataKeys.length !== TIP_METADATA_KEYS.length ||
    !TIP_METADATA_KEYS.every((key, index) => metadataKeys[index] === key)
  ) {
    authorityError(
      'identity_invalid',
      'identity',
      'Tip checkout metadata keys do not match the exact identity contract.',
      objectIds,
      { metadata_keys: metadataKeys }
    )
  }
  if (metadataUserId !== metadataFromUserId) {
    authorityError(
      'identity_conflict',
      'identity',
      'Tip checkout user_id and from_user_id do not match.',
      objectIds,
      { metadata_user_id: metadataUserId, metadata_from_user_id: metadataFromUserId }
    )
  }

  const clientReferenceId = session.client_reference_id
  if (clientReferenceId !== null && clientReferenceId !== tipId) {
    authorityError(
      'object_mismatch',
      'checkout_session',
      'Tip checkout client_reference_id does not match tip_id.',
      objectIds,
      { client_reference_id: clientReferenceId ?? null, tip_id: tipId }
    )
  }
  const checkoutExpiresAt = exactStripeTimestamp(
    session.expires_at,
    'checkout_session',
    'checkout_expires_at',
    objectIds
  )

  if (
    session.invoice !== null ||
    session.after_expiration !== null ||
    session.allow_promotion_codes === true ||
    session.automatic_tax?.enabled !== false ||
    session.adaptive_pricing?.enabled === true ||
    !isEmptyOptionalStripeCollection(session.discounts) ||
    session.shipping_cost != null
  ) {
    authorityError(
      'invalid_session_state',
      'checkout_session',
      'Completed Tip Checkout Session contains unsupported mutable payment options.',
      objectIds,
      {
        invoice_present: session.invoice !== null,
        after_expiration_present: session.after_expiration !== null,
        allow_promotion_codes: session.allow_promotion_codes ?? null,
        automatic_tax_enabled: session.automatic_tax?.enabled ?? null,
        adaptive_pricing_enabled: session.adaptive_pricing?.enabled ?? null,
        discounts_present: !isEmptyOptionalStripeCollection(session.discounts),
        shipping_cost_present: session.shipping_cost != null,
      }
    )
  }
  const customerId = stripeId(
    session.customer,
    'cus_',
    'checkout_session',
    'checkout session.customer',
    objectIds
  )
  objectIds.customerId = customerId
  const paymentIntentId = stripeId(
    session.payment_intent,
    'pi_',
    'checkout_session',
    'checkout session.payment_intent',
    objectIds
  )
  objectIds.paymentIntentId = paymentIntentId

  const paymentIntent = await retrieveExactStripeObject({
    operation: () =>
      stripe.paymentIntents.retrieve(paymentIntentId, {
        expand: ['latest_charge'],
      }),
    stage: 'payment_intent',
    label: 'PaymentIntent',
    objectId: paymentIntentId,
    objectIds,
  })
  assertObject(paymentIntent, 'payment_intent', 'payment_intent', objectIds)
  const freshPaymentIntentId = stripeId(
    paymentIntent.id,
    'pi_',
    'payment_intent',
    'payment intent.id',
    objectIds
  )
  assertExactId(
    freshPaymentIntentId,
    paymentIntentId,
    'payment_intent',
    'payment intent.id',
    objectIds
  )
  const paymentIntentCustomerId = stripeId(
    paymentIntent.customer,
    'cus_',
    'payment_intent',
    'payment intent.customer',
    objectIds
  )
  assertExactId(
    paymentIntentCustomerId,
    customerId,
    'payment_intent',
    'payment intent.customer',
    objectIds
  )
  if (paymentIntent.status !== 'succeeded') {
    authorityError(
      'invalid_payment_state',
      'payment_intent',
      'PaymentIntent has not succeeded.',
      objectIds,
      { status: paymentIntent.status ?? null }
    )
  }

  const chargeId = stripeId(
    paymentIntent.latest_charge,
    'ch_',
    'payment_intent',
    'payment intent.latest_charge',
    objectIds
  )
  objectIds.chargeId = chargeId
  const charge = await retrieveExactStripeObject({
    operation: () => stripe.charges.retrieve(chargeId),
    stage: 'charge',
    label: 'Charge',
    objectId: chargeId,
    objectIds,
  })
  assertObject(charge, 'charge', 'charge', objectIds)
  const freshChargeId = stripeId(charge.id, 'ch_', 'charge', 'charge.id', objectIds)
  assertExactId(freshChargeId, chargeId, 'charge', 'charge.id', objectIds)
  const chargeCustomerId = stripeId(charge.customer, 'cus_', 'charge', 'charge.customer', objectIds)
  assertExactId(chargeCustomerId, customerId, 'charge', 'charge.customer', objectIds)
  const chargePaymentIntentId = stripeId(
    charge.payment_intent,
    'pi_',
    'charge',
    'charge.payment_intent',
    objectIds
  )
  assertExactId(
    chargePaymentIntentId,
    paymentIntentId,
    'charge',
    'charge.payment_intent',
    objectIds
  )
  if (!charge.paid || !charge.captured || charge.status !== 'succeeded') {
    authorityError(
      'invalid_payment_state',
      'charge',
      'Charge is not paid, captured, and succeeded.',
      objectIds,
      {
        paid: charge.paid ?? null,
        captured: charge.captured ?? null,
        status: charge.status ?? null,
      }
    )
  }

  if (
    typeof session.livemode !== 'boolean' ||
    typeof paymentIntent.livemode !== 'boolean' ||
    typeof charge.livemode !== 'boolean' ||
    session.livemode !== true ||
    session.livemode !== paymentIntent.livemode ||
    session.livemode !== charge.livemode
  ) {
    authorityError('object_mismatch', 'charge', 'Stripe payment modes do not match.', objectIds, {
      session_livemode: session.livemode ?? null,
      payment_intent_livemode: paymentIntent.livemode ?? null,
      charge_livemode: charge.livemode ?? null,
    })
  }

  const amounts = [
    {
      source: 'checkout_session.amount_subtotal',
      value: exactPositiveAmount(
        session.amount_subtotal,
        'checkout_session.amount_subtotal',
        objectIds
      ),
    },
    {
      source: 'checkout_session.amount_total',
      value: exactPositiveAmount(session.amount_total, 'checkout_session.amount_total', objectIds),
    },
    {
      source: 'payment_intent.amount',
      value: exactPositiveAmount(paymentIntent.amount, 'payment_intent.amount', objectIds),
    },
    {
      source: 'payment_intent.amount_received',
      value: exactPositiveAmount(
        paymentIntent.amount_received,
        'payment_intent.amount_received',
        objectIds
      ),
    },
    {
      source: 'charge.amount',
      value: exactPositiveAmount(charge.amount, 'charge.amount', objectIds),
    },
    {
      source: 'charge.amount_captured',
      value: exactPositiveAmount(charge.amount_captured, 'charge.amount_captured', objectIds),
    },
  ]
  const amount = assertAllEqual(amounts, 'amount_mismatch', objectIds)
  const refundSucceededAmount = charge.amount_refunded
  if (
    !Number.isSafeInteger(refundSucceededAmount) ||
    refundSucceededAmount < 0 ||
    refundSucceededAmount > amount ||
    typeof charge.refunded !== 'boolean' ||
    charge.refunded !== (refundSucceededAmount === amount)
  ) {
    authorityError(
      'amount_mismatch',
      'charge',
      'Charge refund aggregate is missing, unsafe, or internally inconsistent.',
      objectIds,
      {
        amount_captured: amount,
        amount_refunded: Number.isSafeInteger(refundSucceededAmount) ? refundSucceededAmount : null,
        refunded: charge.refunded ?? null,
      }
    )
  }
  exactZeroAmount(
    session.total_details?.amount_discount,
    'checkout_session.total_details.amount_discount',
    objectIds
  )
  exactZeroAmount(
    session.total_details?.amount_tax,
    'checkout_session.total_details.amount_tax',
    objectIds
  )
  const shippingAmount = session.total_details?.amount_shipping
  if (shippingAmount !== null && shippingAmount !== undefined) {
    exactZeroAmount(shippingAmount, 'checkout_session.total_details.amount_shipping', objectIds)
  }
  if (metadata.amount_cents !== String(amount)) {
    authorityError(
      'amount_mismatch',
      'product',
      'Tip checkout metadata amount does not match payment authority.',
      objectIds,
      {
        metadata_amount_cents: metadata.amount_cents ?? null,
        authoritative_amount: amount,
      }
    )
  }

  const currency = assertAllEqual(
    [
      {
        source: 'checkout_session.currency',
        value: exactCurrency(session.currency, 'checkout_session.currency', objectIds),
      },
      {
        source: 'payment_intent.currency',
        value: exactCurrency(paymentIntent.currency, 'payment_intent.currency', objectIds),
      },
      {
        source: 'charge.currency',
        value: exactCurrency(charge.currency, 'charge.currency', objectIds),
      },
    ],
    'currency_mismatch',
    objectIds
  )
  if (currency !== 'usd') {
    authorityError('currency_mismatch', 'product', 'Tip payments must use USD.', objectIds, {
      currency,
    })
  }

  return {
    tipId,
    clientReferenceId,
    metadataUserId,
    metadataFromUserId,
    metadataPostId,
    metadataToUserId,
    metadataAmountCents: amount,
    sessionId: requestedSessionId,
    checkoutExpiresAt,
    customerId,
    paymentIntentId,
    chargeId,
    amount,
    currency,
    completedAt: authoritativeCompletedAt(charge.created, objectIds),
    refundSucceededAmount,
    fullyRefunded: charge.refunded,
  }
}

async function assertRefundTombstoneConverged(
  supabase: SupabaseClient<Database>,
  authority: TipPaymentAuthority
): Promise<void> {
  if (authority.refundSucceededAmount === 0) return

  const { data, error } = await supabase
    .from('stripe_charge_refund_tombstones')
    .select(
      'stripe_charge_id,stripe_customer_id,stripe_payment_intent_id,captured,amount_paid,currency,refund_succeeded_amount'
    )
    .eq('stripe_charge_id', authority.chargeId)
    .maybeSingle()
  if (error) {
    throw new Error(`Failed to verify durable Charge refund convergence: ${error.message}`)
  }
  if (
    !data ||
    data.stripe_charge_id !== authority.chargeId ||
    data.stripe_customer_id !== authority.customerId ||
    data.stripe_payment_intent_id !== authority.paymentIntentId ||
    data.captured !== true ||
    data.amount_paid !== authority.amount ||
    data.currency !== authority.currency ||
    data.refund_succeeded_amount !== authority.refundSucceededAmount
  ) {
    throw new Error(`Fresh Charge ${authority.chargeId} refund authority has not durably converged`)
  }
}

function readCompletionStatus(data: Json, authority: TipPaymentAuthority): TipCompletionStatus {
  if (!data || Array.isArray(data) || typeof data !== 'object' || typeof data.status !== 'string') {
    throw new Error('complete_tip_with_stripe_ownership_atomic returned an invalid result')
  }
  if (!terminalStatuses.has(data.status as TipCompletionStatus)) {
    throw new Error(
      `complete_tip_with_stripe_ownership_atomic returned unexpected status ${data.status}`
    )
  }

  const status = data.status as TipCompletionStatus
  if (
    (status === 'completed' || status === 'already_completed' || status === 'refunded') &&
    data.tip_id !== authority.tipId
  ) {
    throw new Error(
      `complete_tip_with_stripe_ownership_atomic returned ${status} without exact tip identity`
    )
  }

  let financialStatus: string = status
  if (status === 'notification_suppressed') {
    const allowedCompletionStatuses = new Set([
      'completed',
      'already_completed',
      'refunded',
      'identity_conflict',
      'manual_review',
    ])
    if (
      typeof data.completion_status !== 'string' ||
      !allowedCompletionStatuses.has(data.completion_status) ||
      data.notification_status !== 'suppressed' ||
      typeof data.reason_key !== 'string' ||
      !data.reason_key
    ) {
      throw new Error(
        'complete_tip_with_stripe_ownership_atomic returned an invalid notification suppression result'
      )
    }
    financialStatus = data.completion_status
  }

  if (
    authority.fullyRefunded &&
    financialStatus !== 'refunded' &&
    financialStatus !== 'identity_conflict' &&
    financialStatus !== 'manual_review'
  ) {
    throw new Error(
      'complete_tip_with_stripe_ownership_atomic did not preserve the fully refunded Charge state'
    )
  }
  if (authority.refundSucceededAmount === 0 && financialStatus === 'refunded') {
    throw new Error(
      'complete_tip_with_stripe_ownership_atomic returned refunded without fresh Charge authority'
    )
  }
  return status
}

/**
 * Complete a tip from fresh Stripe authority. The signed event and Session
 * snapshot attest live mode and identify the Checkout Session; every mutable
 * payment field is retrieved again before the single service-role transition.
 */
export async function completeTipCheckout(params: {
  stripe: Stripe
  supabase: SupabaseClient<Database>
  sessionId: string
  eventId: string
  eventLivemode: boolean
  snapshotLivemode: boolean
}): Promise<TipCompletionOutcome> {
  if (
    params.eventLivemode !== true ||
    params.snapshotLivemode !== true ||
    params.eventLivemode !== params.snapshotLivemode
  ) {
    await recordStripeCheckoutManualReview({
      supabase: params.supabase,
      objectType: 'tip_checkout',
      sessionId: stableReviewObjectId(params.sessionId, params.eventId),
      userId: null,
      reasonKey: 'tip_checkout_authority:signed_mode:object_mismatch',
      reason: 'The signed Tip event and Checkout Session snapshot must both be live mode.',
      context: {
        event_id: params.eventId || null,
        event_livemode: params.eventLivemode,
        snapshot_livemode: params.snapshotLivemode,
      },
    })
    return { status: 'manual_review', reviewCode: 'object_mismatch' }
  }

  let authority: TipPaymentAuthority
  try {
    authority = await resolveTipPaymentAuthority(params.stripe, params.sessionId)
  } catch (error) {
    if (!(error instanceof StripeAuthorityError)) throw error
    await recordStripeCheckoutManualReview({
      supabase: params.supabase,
      objectType: 'tip_checkout',
      sessionId: stableReviewObjectId(params.sessionId, params.eventId),
      userId: null,
      reasonKey: `tip_checkout_authority:${error.stage}:${error.code}`,
      reason: error.message,
      context: reviewContext(error, params.eventId),
    })
    return { status: 'manual_review', reviewCode: error.code }
  }

  await assertRefundTombstoneConverged(params.supabase, authority)

  const { data, error } = await params.supabase.rpc('complete_tip_with_stripe_ownership_atomic', {
    p_tip_id: authority.tipId,
    p_stripe_customer_id: authority.customerId,
    p_stripe_payment_intent_id: authority.paymentIntentId,
    p_stripe_charge_id: authority.chargeId,
    p_checkout_session_id: authority.sessionId,
    p_amount_paid: authority.amount,
    p_currency: authority.currency,
    p_completed_at: authority.completedAt,
    p_client_reference_id: authority.clientReferenceId,
    p_metadata_user_id: authority.metadataUserId,
    p_metadata_from_user_id: authority.metadataFromUserId,
    p_metadata_post_id: authority.metadataPostId,
    p_metadata_to_user_id: authority.metadataToUserId,
    p_metadata_amount_cents: authority.metadataAmountCents,
    p_checkout_expires_at: authority.checkoutExpiresAt,
    p_event_id: params.eventId,
  })
  if (error) {
    throw new Error(`Failed to complete tip atomically: ${error.message}`)
  }
  const status = readCompletionStatus(data, authority)

  return {
    status,
    authority,
    result: data,
  }
}
