import Stripe from 'stripe'
import { getSupabase, logger } from './shared'
import { getStripe } from '@/lib/stripe'
import { stripeObjectId } from '@/lib/stripe/identity'
import type { Database, Json } from '@/lib/supabase/database.types'

export type StripeRefundEventContext = {
  eventId: string
  eventCreatedAt: number
}

type EntitlementPaymentRow = Database['public']['Tables']['stripe_entitlement_payments']['Row']

type EntitlementPaymentIdentity = Pick<
  EntitlementPaymentRow,
  | 'id'
  | 'user_id'
  | 'stripe_customer_id'
  | 'payment_kind'
  | 'plan'
  | 'stripe_subscription_id'
  | 'stripe_invoice_id'
  | 'stripe_payment_intent_id'
  | 'stripe_charge_id'
  | 'checkout_session_id'
  | 'amount_paid'
  | 'currency'
  | 'period_start'
  | 'period_end'
  | 'payment_status'
>

type ChargeRefundSnapshot = {
  chargeId: string
  customerId: string
  paymentIntentId: string | null
  capturedAmount: number
  stripeRefundedAmount: number
  currency: string
}

type ChargeRefundAuthority = ChargeRefundSnapshot & {
  succeededRefundedAmount: number
}

type RefundEventIdentity = {
  eventId: string
  eventCreatedAt: string
}

type StripeRefundState = 'pending' | 'requires_action' | 'succeeded' | 'failed' | 'canceled'

type RefundObservationIdentity = {
  refundId: string
  chargeId: string | null
  paymentIntentId: string | null
  amount: number
  currency: string
  state: StripeRefundState
}

type RefundLocator = {
  refundId: string
}

type DeterministicRefundReview = {
  objectType:
    | 'charge'
    | 'entitlement_payment'
    | 'payment_intent'
    | 'refund'
    | 'refund_event'
    | 'subscription'
  objectId: string
  userId: string | null
  reasonKey: string
  reason: string
  evidence: { [key: string]: Json | undefined }
}

class DeterministicRefundPoisonError extends Error {
  readonly review: DeterministicRefundReview

  constructor(review: DeterministicRefundReview) {
    super(review.reason)
    this.name = 'DeterministicRefundPoisonError'
    this.review = review
  }
}

const ENTITLEMENT_PAYMENT_SELECT = [
  'id',
  'user_id',
  'stripe_customer_id',
  'payment_kind',
  'plan',
  'stripe_subscription_id',
  'stripe_invoice_id',
  'stripe_payment_intent_id',
  'stripe_charge_id',
  'checkout_session_id',
  'amount_paid',
  'currency',
  'period_start',
  'period_end',
  'payment_status',
].join(',')

const RECONCILIATION_STATUSES = new Set([
  'refund_recorded',
  'partial_refund',
  'refund_pending',
  'revoked',
  'grant_protected',
  'already_revoked',
  'restored',
  'not_current',
  'subject_deleted',
  'already_reconciled',
  'identity_conflict',
  'manual_review',
  'restore_not_authorized',
])

const RECONCILIATION_ATTENTION_STATUSES = new Set([
  'identity_conflict',
  'manual_review',
  'restore_not_authorized',
])

const TOMBSTONE_RECORD_STATUSES = new Set([
  'recorded',
  'already_recorded',
  'stale_observation',
  'full_refund_terminal',
])

const TOMBSTONE_DURABLE_ATTENTION_STATUSES = new Set(['identity_conflict', 'manual_review'])

const TOMBSTONE_RECORD_OR_RECONCILIATION_STATUSES = new Set([
  ...TOMBSTONE_RECORD_STATUSES,
  'payment_reconciliation_required',
])

const OWNERSHIP_CLAIM_STATUSES = new Set(['claimed', 'already_claimed'])

const NON_ENTITLEMENT_PROJECTION_STATUSES = new Set([
  'resolved',
  'already_resolved',
  'revocation_acknowledged',
])

const PRO_TOMBSTONE_PROJECTION_STATUSES = new Set([
  'no_tombstone',
  'already_merged',
  'merged',
  'refunded_payment',
])

const STRIPE_REFUND_STATES = new Set<StripeRefundState>([
  'pending',
  'requires_action',
  'succeeded',
  'failed',
  'canceled',
])

const STRIPE_SUBSCRIPTION_STATUSES = new Set<Stripe.Subscription.Status>([
  'active',
  'canceled',
  'incomplete',
  'incomplete_expired',
  'past_due',
  'paused',
  'trialing',
  'unpaid',
])

const MANUAL_REVIEW_STATUSES = new Set(['recorded', 'already_recorded'])

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MAX_STRIPE_OBJECT_ID_LENGTH = 255

type TombstoneAcknowledgement =
  | {
      status: string
      route: 'pro_entitlement'
      entitlementPaymentId: string
      ownershipId: string
      productKind: 'pro_entitlement'
      projectionStatus: string
    }
  | {
      status: string
      route: 'non_entitlement'
      entitlementPaymentId: null
      ownershipId: string
      productKind: 'group_pass' | 'tip'
      projectionStatus: string
    }
  | {
      status: string
      route: 'durable_attention'
      entitlementPaymentId: null
      ownershipId: string | null
      productKind: 'group_pass' | 'pro_entitlement' | 'tip' | null
      projectionStatus: null
    }
  | {
      status: string
      route: 'unclassified'
      entitlementPaymentId: null
      ownershipId: null
      productKind: null
      projectionStatus: null
    }

function isStripeRefundState(value: unknown): value is StripeRefundState {
  return typeof value === 'string' && STRIPE_REFUND_STATES.has(value as StripeRefundState)
}

function isOpaqueStripeObjectId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_STRIPE_OBJECT_ID_LENGTH &&
    value.trim() === value
  )
}

function hasExactKeys(result: Record<string, unknown>, expectedKeys: readonly string[]): boolean {
  const actual = Object.keys(result).sort()
  const expected = [...expectedKeys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function deterministicPoison(review: DeterministicRefundReview): never {
  throw new DeterministicRefundPoisonError(review)
}

function reviewObjectId(value: unknown, fallback: string): string {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed.length > 0 && trimmed.length <= 255) return trimmed
  }
  return fallback
}

function safeEvidenceString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  return value.slice(0, 255)
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
      candidate.type === 'StripeInvalidRequestError' ||
      candidate.name === 'StripeInvalidRequestError')
  )
}

function readRefundEventIdentity(
  context: StripeRefundEventContext,
  fallbackObjectType: 'charge' | 'refund',
  fallbackObjectId: unknown
): RefundEventIdentity {
  if (!context?.eventId?.startsWith('evt_')) {
    deterministicPoison({
      objectType: fallbackObjectType,
      objectId: reviewObjectId(fallbackObjectId, 'invalid_refund_event'),
      userId: null,
      reasonKey: 'invalid_refund_event_identity',
      reason: 'A signed Stripe refund event has no valid immutable event identity.',
      evidence: {
        event_id: safeEvidenceString(context?.eventId),
        event_created_at:
          Number.isSafeInteger(context?.eventCreatedAt) && context.eventCreatedAt > 0
            ? context.eventCreatedAt
            : null,
      },
    })
  }
  if (!Number.isSafeInteger(context.eventCreatedAt) || context.eventCreatedAt <= 0) {
    deterministicPoison({
      objectType: 'refund_event',
      objectId: context.eventId,
      userId: null,
      reasonKey: 'invalid_refund_event_identity',
      reason: 'A signed Stripe refund event has an invalid immutable creation time.',
      evidence: {
        event_id: context.eventId,
        event_created_at: null,
      },
    })
  }
  const createdAt = new Date(context.eventCreatedAt * 1000)
  if (!Number.isFinite(createdAt.getTime())) {
    deterministicPoison({
      objectType: 'refund_event',
      objectId: context.eventId,
      userId: null,
      reasonKey: 'invalid_refund_event_identity',
      reason: 'A signed Stripe refund event creation time cannot be represented safely.',
      evidence: {
        event_id: context.eventId,
        event_created_at: context.eventCreatedAt,
      },
    })
  }
  return {
    eventId: context.eventId,
    eventCreatedAt: createdAt.toISOString(),
  }
}

function readChargeRefundSnapshot(
  charge: Stripe.Charge,
  options: {
    allowZeroRefund?: boolean
    eventId: string
    source: 'fresh' | 'signed'
  }
): ChargeRefundSnapshot {
  const chargeId = stripeObjectId(charge.id)
  const customerId = stripeObjectId(charge.customer)
  const paymentIntentId =
    charge.payment_intent == null ? null : stripeObjectId(charge.payment_intent)
  const capturedAmount = charge.amount_captured
  const stripeRefundedAmount = charge.amount_refunded
  const currency = charge.currency?.trim().toLowerCase()

  if (
    !chargeId ||
    !chargeId.startsWith('ch_') ||
    !customerId ||
    !customerId.startsWith('cus_') ||
    (charge.payment_intent != null && (!paymentIntentId || !paymentIntentId.startsWith('pi_'))) ||
    charge.captured !== true ||
    charge.paid !== true ||
    charge.status !== 'succeeded' ||
    !Number.isSafeInteger(capturedAmount) ||
    capturedAmount <= 0 ||
    !Number.isSafeInteger(stripeRefundedAmount) ||
    stripeRefundedAmount < (options.allowZeroRefund ? 0 : 1) ||
    stripeRefundedAmount > capturedAmount ||
    !currency ||
    !/^[a-z]{3}$/.test(currency) ||
    charge.refunded !== (stripeRefundedAmount === capturedAmount)
  ) {
    deterministicPoison({
      objectType: 'charge',
      objectId: reviewObjectId(chargeId, options.eventId),
      userId: null,
      reasonKey: `${options.source}_charge_invalid_refund_shape`,
      reason: `A ${options.source} Stripe Charge has an invalid immutable refund shape.`,
      evidence: {
        event_id: options.eventId,
        charge_id: safeEvidenceString(chargeId),
        customer_id: safeEvidenceString(customerId),
        payment_intent_id: safeEvidenceString(paymentIntentId),
        captured: charge.captured,
        paid: charge.paid,
        charge_status: safeEvidenceString(charge.status),
        amount_captured: Number.isSafeInteger(capturedAmount) ? capturedAmount : null,
        amount_refunded: Number.isSafeInteger(stripeRefundedAmount) ? stripeRefundedAmount : null,
        currency: safeEvidenceString(currency),
        fully_refunded: charge.refunded,
      },
    })
  }

  return {
    chargeId,
    customerId,
    paymentIntentId,
    capturedAmount,
    stripeRefundedAmount,
    currency,
  }
}

function assertFreshChargeMatchesEvent(
  eventCharge: ChargeRefundSnapshot,
  freshSnapshot: ChargeRefundSnapshot,
  event: RefundEventIdentity
): void {
  if (
    freshSnapshot.chargeId !== eventCharge.chargeId ||
    freshSnapshot.customerId !== eventCharge.customerId ||
    freshSnapshot.paymentIntentId !== eventCharge.paymentIntentId ||
    freshSnapshot.capturedAmount !== eventCharge.capturedAmount ||
    freshSnapshot.currency !== eventCharge.currency
  ) {
    deterministicPoison({
      objectType: 'charge',
      objectId: eventCharge.chargeId,
      userId: null,
      reasonKey: 'fresh_charge_signed_identity_conflict',
      reason: 'A fresh Stripe Charge conflicts with immutable identity in the signed refund event.',
      evidence: {
        event_id: event.eventId,
        charge_id: eventCharge.chargeId,
        event_customer_id: eventCharge.customerId,
        fresh_customer_id: freshSnapshot.customerId,
        event_payment_intent_id: eventCharge.paymentIntentId,
        fresh_payment_intent_id: freshSnapshot.paymentIntentId,
        event_amount_captured: eventCharge.capturedAmount,
        fresh_amount_captured: freshSnapshot.capturedAmount,
        event_currency: eventCharge.currency,
        fresh_currency: freshSnapshot.currency,
      },
    })
  }
  if (freshSnapshot.stripeRefundedAmount < eventCharge.stripeRefundedAmount) {
    throw new Error(
      `Fresh Charge ${eventCharge.chargeId} decreased below the signed refund event aggregate`
    )
  }
}

async function retrieveFreshChargeRefundSnapshot(
  chargeId: string,
  event: RefundEventIdentity
): Promise<ChargeRefundSnapshot> {
  let freshCharge: Stripe.Charge
  try {
    freshCharge = await getStripe().charges.retrieve(chargeId)
  } catch (error) {
    if (isStripeResourceMissing(error)) {
      deterministicPoison({
        objectType: 'charge',
        objectId: chargeId,
        userId: null,
        reasonKey: 'stripe_charge_resource_missing',
        reason: 'The exact Stripe Charge is missing from the configured account and mode.',
        evidence: {
          event_id: event.eventId,
          charge_id: chargeId,
          stripe_error_code: 'resource_missing',
        },
      })
    }
    throw error
  }
  const freshSnapshot = readChargeRefundSnapshot(freshCharge, {
    allowZeroRefund: true,
    eventId: event.eventId,
    source: 'fresh',
  })
  if (freshSnapshot.chargeId !== chargeId) {
    deterministicPoison({
      objectType: 'charge',
      objectId: chargeId,
      userId: null,
      reasonKey: 'stripe_charge_retrieval_identity_conflict',
      reason: 'Stripe Charge retrieval returned a different immutable Charge identity.',
      evidence: {
        event_id: event.eventId,
        requested_charge_id: chargeId,
        returned_charge_id: freshSnapshot.chargeId,
      },
    })
  }
  return freshSnapshot
}

function readSignedRefundLocator(refund: Stripe.Refund, event: RefundEventIdentity): RefundLocator {
  const refundId = refund?.id
  if (!isOpaqueStripeObjectId(refundId)) {
    deterministicPoison({
      objectType: 'refund',
      objectId: reviewObjectId(refundId, event.eventId),
      userId: null,
      reasonKey: 'signed_refund_invalid_locator',
      reason: 'A signed Stripe refund event has no valid opaque Refund id.',
      evidence: {
        event_id: event.eventId,
        refund_id: safeEvidenceString(refundId),
      },
    })
  }
  return { refundId }
}

function readFreshRefundObservation(
  refund: Stripe.Refund,
  event: RefundEventIdentity
): RefundObservationIdentity {
  const refundId = refund?.id
  const chargeId = refund.charge == null ? null : stripeObjectId(refund.charge)
  const paymentIntentId =
    refund.payment_intent == null ? null : stripeObjectId(refund.payment_intent)
  const amount = refund.amount
  const currency = refund.currency?.trim().toLowerCase()
  const state = refund.status
  if (
    !isOpaqueStripeObjectId(refundId) ||
    (refund.charge != null && (!chargeId || !chargeId.startsWith('ch_'))) ||
    (refund.payment_intent != null && (!paymentIntentId || !paymentIntentId.startsWith('pi_'))) ||
    !Number.isSafeInteger(amount) ||
    amount <= 0 ||
    !currency ||
    !/^[a-z]{3}$/.test(currency) ||
    !isStripeRefundState(state)
  ) {
    deterministicPoison({
      objectType: 'refund',
      objectId: reviewObjectId(refundId, event.eventId),
      userId: null,
      reasonKey: 'fresh_refund_invalid_shape',
      reason: 'A fresh Stripe Refund has an invalid immutable financial shape.',
      evidence: {
        event_id: event.eventId,
        refund_id: safeEvidenceString(refundId),
        charge_id: safeEvidenceString(chargeId),
        payment_intent_id: safeEvidenceString(paymentIntentId),
        amount: Number.isSafeInteger(amount) ? amount : null,
        currency: safeEvidenceString(currency),
        refund_status: safeEvidenceString(state),
      },
    })
  }
  return {
    refundId,
    chargeId,
    paymentIntentId,
    amount,
    currency,
    state,
  }
}

async function retrieveFreshRefundObservation(
  refundId: string,
  event: RefundEventIdentity
): Promise<RefundObservationIdentity> {
  let freshRefund: Stripe.Refund
  try {
    freshRefund = await getStripe().refunds.retrieve(refundId)
  } catch (error) {
    if (isStripeResourceMissing(error)) {
      deterministicPoison({
        objectType: 'refund',
        objectId: refundId,
        userId: null,
        reasonKey: 'stripe_refund_resource_missing',
        reason: 'The exact Stripe Refund is missing from the configured account and mode.',
        evidence: {
          event_id: event.eventId,
          refund_id: refundId,
          stripe_error_code: 'resource_missing',
        },
      })
    }
    throw error
  }
  const observation = readFreshRefundObservation(freshRefund, event)
  if (observation.refundId !== refundId) {
    deterministicPoison({
      objectType: 'refund',
      objectId: refundId,
      userId: null,
      reasonKey: 'stripe_refund_retrieval_identity_conflict',
      reason: 'Stripe Refund retrieval returned a different immutable Refund identity.',
      evidence: {
        event_id: event.eventId,
        requested_refund_id: refundId,
        returned_refund_id: observation.refundId,
      },
    })
  }
  return observation
}

async function resolveRefundChargeId(
  refund: RefundObservationIdentity,
  event: RefundEventIdentity
): Promise<string> {
  if (refund.chargeId) return refund.chargeId
  if (!refund.paymentIntentId) {
    deterministicPoison({
      objectType: 'refund',
      objectId: refund.refundId,
      userId: null,
      reasonKey: 'refund_without_charge_authority',
      reason: 'A fresh Stripe Refund has neither Charge nor PaymentIntent authority.',
      evidence: {
        event_id: event.eventId,
        refund_id: refund.refundId,
      },
    })
  }

  let paymentIntent: Stripe.PaymentIntent
  try {
    paymentIntent = await getStripe().paymentIntents.retrieve(refund.paymentIntentId)
  } catch (error) {
    if (isStripeResourceMissing(error)) {
      deterministicPoison({
        objectType: 'payment_intent',
        objectId: refund.paymentIntentId,
        userId: null,
        reasonKey: 'stripe_payment_intent_resource_missing',
        reason: 'The Refund PaymentIntent is missing from the configured Stripe account and mode.',
        evidence: {
          event_id: event.eventId,
          refund_id: refund.refundId,
          payment_intent_id: refund.paymentIntentId,
          stripe_error_code: 'resource_missing',
        },
      })
    }
    throw error
  }
  const returnedPaymentIntentId = stripeObjectId(paymentIntent.id)
  const latestChargeId = stripeObjectId(paymentIntent.latest_charge)
  if (
    returnedPaymentIntentId !== refund.paymentIntentId ||
    !latestChargeId ||
    !latestChargeId.startsWith('ch_')
  ) {
    deterministicPoison({
      objectType: 'payment_intent',
      objectId: refund.paymentIntentId,
      userId: null,
      reasonKey: 'refund_payment_intent_charge_identity_conflict',
      reason: 'The Refund PaymentIntent has no exact latest Charge authority.',
      evidence: {
        event_id: event.eventId,
        refund_id: refund.refundId,
        requested_payment_intent_id: refund.paymentIntentId,
        returned_payment_intent_id: safeEvidenceString(returnedPaymentIntentId),
        latest_charge_id: safeEvidenceString(latestChargeId),
      },
    })
  }
  return latestChargeId
}

function assertRefundMatchesCharge(
  refund: RefundObservationIdentity,
  charge: ChargeRefundSnapshot,
  event: RefundEventIdentity
): void {
  if (
    (refund.chargeId === null && refund.paymentIntentId === null) ||
    (refund.chargeId !== null && refund.chargeId !== charge.chargeId) ||
    (refund.paymentIntentId !== null && refund.paymentIntentId !== charge.paymentIntentId) ||
    refund.currency !== charge.currency ||
    refund.amount > charge.capturedAmount
  ) {
    deterministicPoison({
      objectType: 'refund',
      objectId: refund.refundId,
      userId: null,
      reasonKey: 'refund_charge_identity_conflict',
      reason: 'A fresh Stripe Refund conflicts with the exact Charge financial identity.',
      evidence: {
        event_id: event.eventId,
        refund_id: refund.refundId,
        refund_charge_id: refund.chargeId,
        exact_charge_id: charge.chargeId,
        refund_payment_intent_id: refund.paymentIntentId,
        charge_payment_intent_id: charge.paymentIntentId,
        refund_amount: refund.amount,
        charge_amount_captured: charge.capturedAmount,
        refund_currency: refund.currency,
        charge_currency: charge.currency,
      },
    })
  }
}

async function readSucceededRefundAuthority(
  charge: ChargeRefundSnapshot,
  event: RefundEventIdentity,
  triggeringRefund: RefundObservationIdentity | null
): Promise<ChargeRefundAuthority> {
  const seenRefundIds = new Set<string>()
  const seenCursors = new Set<string>()
  let startingAfter: string | undefined
  let succeededRefundedAmount = 0
  let triggeringRefundFound = triggeringRefund === null
  let pageCount = 0

  while (true) {
    pageCount += 1
    if (pageCount > 10_000) {
      throw new Error(`Refund pagination for Charge ${charge.chargeId} exceeded the safe limit`)
    }
    const params: Stripe.RefundListParams = {
      charge: charge.chargeId,
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    }
    const page = await getStripe().refunds.list(params)
    if (!page || !Array.isArray(page.data) || typeof page.has_more !== 'boolean') {
      throw new Error(`Stripe returned malformed Refund pagination for Charge ${charge.chargeId}`)
    }
    if (page.has_more && page.data.length === 0) {
      throw new Error(
        `Stripe returned an empty continuing Refund page for Charge ${charge.chargeId}`
      )
    }

    let lastRefundId: string | null = null
    for (const listedRefund of page.data) {
      const observation = readFreshRefundObservation(listedRefund, event)
      if (seenRefundIds.has(observation.refundId)) {
        throw new Error(
          `Stripe repeated Refund ${observation.refundId} while paginating Charge ${charge.chargeId}`
        )
      }
      seenRefundIds.add(observation.refundId)
      lastRefundId = observation.refundId
      if (observation.refundId === triggeringRefund?.refundId) {
        if (
          observation.chargeId !== triggeringRefund.chargeId ||
          observation.paymentIntentId !== triggeringRefund.paymentIntentId ||
          observation.amount !== triggeringRefund.amount ||
          observation.currency !== triggeringRefund.currency ||
          observation.state !== triggeringRefund.state
        ) {
          throw new Error(
            `Fresh Refund ${triggeringRefund.refundId} retrieval and Charge pagination have not converged`
          )
        }
        triggeringRefundFound = true
      }
      assertRefundMatchesCharge(observation, charge, event)

      if (observation.state === 'succeeded') {
        const nextAmount = succeededRefundedAmount + observation.amount
        if (!Number.isSafeInteger(nextAmount) || nextAmount > charge.capturedAmount) {
          deterministicPoison({
            objectType: 'charge',
            objectId: charge.chargeId,
            userId: null,
            reasonKey: 'succeeded_refund_aggregate_invalid',
            reason: 'Succeeded Stripe Refunds exceed the exact captured Charge amount.',
            evidence: {
              event_id: event.eventId,
              charge_id: charge.chargeId,
              refund_id: observation.refundId,
              succeeded_refund_amount: nextAmount,
              captured_amount: charge.capturedAmount,
            },
          })
        }
        succeededRefundedAmount = nextAmount
      }
    }

    if (!page.has_more) break
    if (!lastRefundId || seenCursors.has(lastRefundId)) {
      throw new Error(`Stripe Refund pagination did not advance for Charge ${charge.chargeId}`)
    }
    seenCursors.add(lastRefundId)
    startingAfter = lastRefundId
  }

  if (!triggeringRefundFound) {
    throw new Error(
      `Fresh Refund ${triggeringRefund?.refundId} is not yet visible in Charge ${charge.chargeId} pagination`
    )
  }
  if (succeededRefundedAmount !== charge.stripeRefundedAmount) {
    throw new Error(
      `Fresh Charge ${charge.chargeId} and succeeded Refund pagination have not converged`
    )
  }
  return {
    ...charge,
    succeededRefundedAmount,
  }
}

function readStatusAcknowledgement(
  value: unknown,
  allowedStatuses: ReadonlySet<string>,
  source: string
): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${source} returned a malformed acknowledgement`)
  }
  const result = value as Record<string, unknown>
  if (
    Object.keys(result).length !== 1 ||
    typeof result.status !== 'string' ||
    !allowedStatuses.has(result.status)
  ) {
    throw new Error(`${source} returned an unknown or non-exact acknowledgement`)
  }
  return result.status
}

function readTombstoneAcknowledgement(value: unknown): TombstoneAcknowledgement {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Charge refund tombstone RPC returned a malformed acknowledgement')
  }
  const result = value as Record<string, unknown>
  const status = typeof result.status === 'string' ? result.status : null

  if (
    status &&
    TOMBSTONE_DURABLE_ATTENTION_STATUSES.has(status) &&
    hasExactKeys(result, ['status'])
  ) {
    return {
      status,
      route: 'durable_attention',
      entitlementPaymentId: null,
      ownershipId: null,
      productKind: null,
      projectionStatus: null,
    }
  }

  if (
    status &&
    TOMBSTONE_DURABLE_ATTENTION_STATUSES.has(status) &&
    hasExactKeys(result, ['status', 'record_status']) &&
    typeof result.record_status === 'string' &&
    TOMBSTONE_RECORD_OR_RECONCILIATION_STATUSES.has(result.record_status)
  ) {
    return {
      status,
      route: 'durable_attention',
      entitlementPaymentId: null,
      ownershipId: null,
      productKind: null,
      projectionStatus: null,
    }
  }

  if (
    status &&
    TOMBSTONE_DURABLE_ATTENTION_STATUSES.has(status) &&
    hasExactKeys(result, ['status', 'ownership_id', 'record_status']) &&
    typeof result.ownership_id === 'string' &&
    UUID_PATTERN.test(result.ownership_id) &&
    typeof result.record_status === 'string' &&
    TOMBSTONE_RECORD_OR_RECONCILIATION_STATUSES.has(result.record_status)
  ) {
    return {
      status,
      route: 'durable_attention',
      entitlementPaymentId: null,
      ownershipId: result.ownership_id,
      productKind: null,
      projectionStatus: null,
    }
  }

  if (
    status === 'manual_review' &&
    hasExactKeys(result, [
      'status',
      'ownership_id',
      'product_kind',
      'reason_key',
      'record_status',
    ]) &&
    typeof result.ownership_id === 'string' &&
    UUID_PATTERN.test(result.ownership_id) &&
    result.product_kind === 'group_pass' &&
    result.reason_key === 'group_pass_full_refund_revocation_required' &&
    typeof result.record_status === 'string' &&
    TOMBSTONE_RECORD_OR_RECONCILIATION_STATUSES.has(result.record_status)
  ) {
    return {
      status,
      route: 'durable_attention',
      entitlementPaymentId: null,
      ownershipId: result.ownership_id,
      productKind: 'group_pass',
      projectionStatus: null,
    }
  }

  if (
    result.status === 'payment_reconciliation_required' &&
    hasExactKeys(result, [
      'status',
      'entitlement_payment_id',
      'ownership_status',
      'ownership_id',
      'product_kind',
      'projection_status',
    ])
  ) {
    if (
      typeof result.entitlement_payment_id !== 'string' ||
      !UUID_PATTERN.test(result.entitlement_payment_id) ||
      result.product_kind !== 'pro_entitlement' ||
      typeof result.ownership_id !== 'string' ||
      !UUID_PATTERN.test(result.ownership_id) ||
      typeof result.ownership_status !== 'string' ||
      !OWNERSHIP_CLAIM_STATUSES.has(result.ownership_status) ||
      typeof result.projection_status !== 'string' ||
      !PRO_TOMBSTONE_PROJECTION_STATUSES.has(result.projection_status)
    ) {
      throw new Error(
        'Charge refund tombstone RPC returned an invalid Pro reconciliation acknowledgement'
      )
    }
    return {
      status: result.status,
      route: 'pro_entitlement',
      entitlementPaymentId: result.entitlement_payment_id,
      ownershipId: result.ownership_id,
      productKind: 'pro_entitlement',
      projectionStatus: result.projection_status,
    }
  }

  if (!status || !TOMBSTONE_RECORD_STATUSES.has(status)) {
    throw new Error('Charge refund tombstone RPC returned an unknown acknowledgement')
  }

  if (
    result.ownership_status === 'unclassified' &&
    hasExactKeys(result, ['status', 'ownership_status'])
  ) {
    return {
      status,
      route: 'unclassified',
      entitlementPaymentId: null,
      ownershipId: null,
      productKind: null,
      projectionStatus: null,
    }
  }

  if (
    typeof result.ownership_status === 'string' &&
    OWNERSHIP_CLAIM_STATUSES.has(result.ownership_status) &&
    typeof result.ownership_id === 'string' &&
    UUID_PATTERN.test(result.ownership_id) &&
    (result.product_kind === 'tip' || result.product_kind === 'group_pass') &&
    typeof result.projection_status === 'string' &&
    NON_ENTITLEMENT_PROJECTION_STATUSES.has(result.projection_status) &&
    hasExactKeys(result, [
      'status',
      'ownership_status',
      'ownership_id',
      'product_kind',
      'projection_status',
    ])
  ) {
    return {
      status,
      route: 'non_entitlement',
      entitlementPaymentId: null,
      ownershipId: result.ownership_id,
      productKind: result.product_kind,
      projectionStatus: result.projection_status,
    }
  }

  throw new Error('Charge refund tombstone RPC returned contradictory product ownership')
}

function readManualReviewAcknowledgement(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Stripe refund manual review RPC returned an invalid acknowledgement')
  }
  const result = value as Record<string, unknown>
  if (
    Object.keys(result).length !== 1 ||
    typeof result.status !== 'string' ||
    !MANUAL_REVIEW_STATUSES.has(result.status)
  ) {
    throw new Error('Stripe refund manual review RPC returned an invalid acknowledgement')
  }
  return result.status
}

async function persistDeterministicRefundReview(
  poison: DeterministicRefundPoisonError
): Promise<void> {
  const review = poison.review
  const { data, error } = await getSupabase().rpc('record_stripe_manual_review_atomic', {
    p_object_type: review.objectType,
    p_object_id: review.objectId,
    p_user_id: review.userId,
    p_reason_key: review.reasonKey,
    p_reason: review.reason,
    p_context: review.evidence,
  })
  if (error) {
    throw new Error(`Failed to preserve deterministic Stripe refund review: ${error.message}`)
  }
  const status = readManualReviewAcknowledgement(data)
  logger.warn('Deterministic Stripe refund poison preserved for manual review', {
    objectType: review.objectType,
    objectId: review.objectId,
    reasonKey: review.reasonKey,
    status,
  })
}

async function withDeterministicRefundReview(operation: () => Promise<void>): Promise<void> {
  try {
    await operation()
  } catch (error) {
    if (!(error instanceof DeterministicRefundPoisonError)) throw error
    await persistDeterministicRefundReview(error)
  }
}

async function findEntitlementPaymentById(
  paymentId: string
): Promise<EntitlementPaymentIdentity | null> {
  const { data, error } = await getSupabase()
    .from('stripe_entitlement_payments')
    .select(ENTITLEMENT_PAYMENT_SELECT)
    .eq('id', paymentId)
    .maybeSingle()

  if (error) {
    throw new Error(`Failed to read local entitlement payment: ${error.message}`)
  }
  return data as EntitlementPaymentIdentity | null
}

function assertChargeMatchesPayment(
  charge: ChargeRefundSnapshot,
  payment: EntitlementPaymentIdentity,
  event: RefundEventIdentity
): void {
  if (
    payment.stripe_charge_id !== charge.chargeId ||
    payment.stripe_customer_id !== charge.customerId ||
    payment.stripe_payment_intent_id !== charge.paymentIntentId ||
    payment.amount_paid !== charge.capturedAmount ||
    payment.currency !== charge.currency
  ) {
    deterministicPoison({
      objectType: 'entitlement_payment',
      objectId: payment.id,
      userId: payment.user_id,
      reasonKey: 'charge_payment_ledger_identity_conflict',
      reason:
        'A fresh refunded Charge conflicts with immutable local entitlement payment identity.',
      evidence: {
        event_id: event.eventId,
        entitlement_payment_id: payment.id,
        charge_id: charge.chargeId,
        ledger_customer_id: payment.stripe_customer_id,
        charge_customer_id: charge.customerId,
        ledger_payment_intent_id: payment.stripe_payment_intent_id,
        charge_payment_intent_id: charge.paymentIntentId,
        ledger_amount_paid: payment.amount_paid,
        charge_amount_captured: charge.capturedAmount,
        ledger_currency: payment.currency,
        charge_currency: charge.currency,
      },
    })
  }
}

async function readRecurringSubscriptionStatus(
  payment: EntitlementPaymentIdentity,
  event: RefundEventIdentity
): Promise<Stripe.Subscription.Status> {
  const subscriptionId = stripeObjectId(payment.stripe_subscription_id)
  if (!subscriptionId || !subscriptionId.startsWith('sub_')) {
    deterministicPoison({
      objectType: 'entitlement_payment',
      objectId: payment.id,
      userId: payment.user_id,
      reasonKey: 'payment_subscription_identity_invalid',
      reason: 'A recurring entitlement payment has no valid immutable Stripe Subscription id.',
      evidence: {
        event_id: event.eventId,
        entitlement_payment_id: payment.id,
        subscription_id: safeEvidenceString(subscriptionId),
      },
    })
  }
  let subscription: Stripe.Subscription
  try {
    subscription = await getStripe().subscriptions.retrieve(subscriptionId)
  } catch (error) {
    if (isStripeResourceMissing(error)) {
      deterministicPoison({
        objectType: 'subscription',
        objectId: subscriptionId,
        userId: payment.user_id,
        reasonKey: 'stripe_subscription_resource_missing',
        reason: 'The exact Stripe Subscription is missing from the configured account and mode.',
        evidence: {
          event_id: event.eventId,
          entitlement_payment_id: payment.id,
          subscription_id: subscriptionId,
          stripe_error_code: 'resource_missing',
        },
      })
    }
    throw error
  }
  const customerId = stripeObjectId(subscription.customer)
  if (
    subscription.id !== subscriptionId ||
    !customerId ||
    !customerId.startsWith('cus_') ||
    customerId !== payment.stripe_customer_id ||
    !STRIPE_SUBSCRIPTION_STATUSES.has(subscription.status)
  ) {
    deterministicPoison({
      objectType: 'subscription',
      objectId: subscriptionId,
      userId: payment.user_id,
      reasonKey: 'subscription_payment_ledger_identity_conflict',
      reason:
        'A fresh Stripe Subscription conflicts with immutable local entitlement payment identity.',
      evidence: {
        event_id: event.eventId,
        entitlement_payment_id: payment.id,
        requested_subscription_id: subscriptionId,
        returned_subscription_id: safeEvidenceString(subscription.id),
        ledger_customer_id: payment.stripe_customer_id,
        returned_customer_id: safeEvidenceString(customerId),
        subscription_status: safeEvidenceString(subscription.status),
      },
    })
  }
  return subscription.status
}

async function reconcileEntitlementPayment(
  payment: EntitlementPaymentIdentity,
  charge: ChargeRefundAuthority,
  event: RefundEventIdentity,
  refundState: StripeRefundState
): Promise<string> {
  assertChargeMatchesPayment(charge, payment, event)
  if (payment.payment_kind !== 'recurring' && payment.payment_kind !== 'lifetime') {
    deterministicPoison({
      objectType: 'entitlement_payment',
      objectId: payment.id,
      userId: payment.user_id,
      reasonKey: 'unsupported_entitlement_payment_kind',
      reason: 'A local entitlement payment has an unsupported immutable payment kind.',
      evidence: {
        event_id: event.eventId,
        entitlement_payment_id: payment.id,
        payment_kind: safeEvidenceString(payment.payment_kind),
        charge_id: charge.chargeId,
      },
    })
  }
  const subscriptionStatus =
    payment.payment_kind === 'recurring'
      ? await readRecurringSubscriptionStatus(payment, event)
      : null

  const { data, error } = await getSupabase().rpc('reconcile_stripe_entitlement_refund_atomic', {
    p_user_id: payment.user_id,
    p_stripe_customer_id: payment.stripe_customer_id,
    p_payment_kind: payment.payment_kind,
    p_plan: payment.plan,
    p_stripe_subscription_id: payment.stripe_subscription_id,
    p_stripe_invoice_id: payment.stripe_invoice_id,
    p_stripe_payment_intent_id: payment.stripe_payment_intent_id,
    p_stripe_charge_id: payment.stripe_charge_id,
    p_checkout_session_id: payment.checkout_session_id,
    p_amount_paid: payment.amount_paid,
    p_currency: payment.currency,
    p_period_start: payment.period_start,
    p_period_end: payment.period_end,
    p_payment_status: payment.payment_status,
    p_refund_succeeded_amount: charge.succeededRefundedAmount,
    p_refund_state: refundState,
    p_stripe_subscription_status: subscriptionStatus,
    p_refund_event_id: event.eventId,
    p_refund_event_created_at: event.eventCreatedAt,
  })
  if (error) {
    throw new Error(`Failed to reconcile entitlement refund: ${error.message}`)
  }
  return readStatusAcknowledgement(
    data,
    RECONCILIATION_STATUSES,
    'Entitlement refund reconciliation RPC'
  )
}

function logReconciliationOutcome(
  message: string,
  payment: EntitlementPaymentIdentity,
  charge: ChargeRefundAuthority,
  status: string
): void {
  const details = {
    chargeId: charge.chargeId,
    entitlementPaymentId: payment.id,
    status,
  }
  if (RECONCILIATION_ATTENTION_STATUSES.has(status)) {
    logger.warn(message, details)
  } else {
    logger.info(message, details)
  }
}

async function recordChargeTombstone(
  charge: ChargeRefundAuthority,
  event: RefundEventIdentity,
  refundState: StripeRefundState
): Promise<TombstoneAcknowledgement> {
  const { data, error } = await getSupabase().rpc('record_charge_refund_tombstone_atomic', {
    p_user_id: null,
    p_stripe_customer_id: charge.customerId,
    p_stripe_payment_intent_id: charge.paymentIntentId,
    p_stripe_charge_id: charge.chargeId,
    p_captured: true,
    p_amount_paid: charge.capturedAmount,
    p_currency: charge.currency,
    p_refund_succeeded_amount: charge.succeededRefundedAmount,
    p_refund_state: refundState,
    p_refund_event_id: event.eventId,
    p_refund_event_created_at: event.eventCreatedAt,
  })
  if (error) {
    throw new Error(`Failed to record Charge refund tombstone: ${error.message}`)
  }
  return readTombstoneAcknowledgement(data)
}

async function persistChargeRefundObservation(
  snapshot: ChargeRefundAuthority,
  event: RefundEventIdentity,
  refundState: StripeRefundState
): Promise<void> {
  const tombstone = await recordChargeTombstone(snapshot, event, refundState)

  if (tombstone.route === 'pro_entitlement') {
    const payment = await findEntitlementPaymentById(tombstone.entitlementPaymentId)
    if (!payment) {
      throw new Error(
        `Charge refund ${snapshot.chargeId} references an unavailable entitlement payment`
      )
    }
    const status = await reconcileEntitlementPayment(payment, snapshot, event, refundState)
    logReconciliationOutcome(
      'Charge refund reconciled against exact Pro payment ownership',
      payment,
      snapshot,
      status
    )
    return
  }

  const details = {
    chargeId: snapshot.chargeId,
    status: tombstone.status,
    ownershipId: tombstone.ownershipId,
    productKind: tombstone.productKind,
    projectionStatus: tombstone.projectionStatus,
  }

  if (tombstone.route === 'non_entitlement') {
    logger.info('Charge refund projected through exact non-entitlement ownership', details)
    return
  }
  if (tombstone.route === 'unclassified') {
    if (tombstone.status === 'full_refund_terminal') {
      logger.warn('Charge refund preserved as an unclassified terminal tombstone', details)
    } else {
      logger.info('Charge refund preserved as an unclassified financial tombstone', details)
    }
    return
  }

  logger.warn('Charge refund reached a durable review state', details)
}

export async function handleChargeRefunded(
  charge: Stripe.Charge,
  context: StripeRefundEventContext
) {
  await withDeterministicRefundReview(async () => {
    const event = readRefundEventIdentity(context, 'charge', charge?.id)
    const eventSnapshot = readChargeRefundSnapshot(charge, {
      eventId: event.eventId,
      source: 'signed',
    })
    const snapshot = await retrieveFreshChargeRefundSnapshot(eventSnapshot.chargeId, event)
    assertFreshChargeMatchesEvent(eventSnapshot, snapshot, event)
    const authority = await readSucceededRefundAuthority(snapshot, event, null)
    await persistChargeRefundObservation(authority, event, 'succeeded')
  })
}

export async function handleRefundLifecycle(
  refund: Stripe.Refund,
  context: StripeRefundEventContext
) {
  await withDeterministicRefundReview(async () => {
    const event = readRefundEventIdentity(context, 'refund', refund?.id)
    const locator = readSignedRefundLocator(refund, event)
    const observation = await retrieveFreshRefundObservation(locator.refundId, event)
    const chargeId = await resolveRefundChargeId(observation, event)
    const snapshot = await retrieveFreshChargeRefundSnapshot(chargeId, event)
    assertRefundMatchesCharge(observation, snapshot, event)
    const authority = await readSucceededRefundAuthority(snapshot, event, observation)
    const aggregateState =
      authority.succeededRefundedAmount === authority.capturedAmount
        ? 'succeeded'
        : observation.state
    await persistChargeRefundObservation(authority, event, aggregateState)
  })
}

// Compatibility export for internal callers while endpoint subscriptions move
// from legacy charge refund events to the canonical Refund lifecycle.
export const handleRefundUpdated = handleRefundLifecycle

/**
 * Chargeback / dispute (2026-07-11 上线审计:此前 webhook 完全不处理 dispute)。
 * 切 live 后首笔 chargeback:钱被划走 + $15 dispute fee,用户还留着 Pro,团队
 * 无感知。这里最小处置:记 payment_history + Telegram 告警(不自动撤权——
 * dispute 可能被商家赢回,撤权留人工在 Stripe Dashboard 判)。webhook 事件
 * 订阅需在 Stripe 后台加 charge.dispute.created(见 docs/STRIPE_GO_LIVE.md)。
 */
export async function handleChargeDisputeCreated(dispute: Stripe.Dispute) {
  const charge = typeof dispute.charge === 'string' ? dispute.charge : dispute.charge?.id
  logger.error('Chargeback/dispute created', {
    disputeId: dispute.id,
    chargeId: charge,
    amount: dispute.amount,
    reason: dispute.reason,
    status: dispute.status,
  })
  try {
    const { sendAlert } = await import('@/lib/alerts/send-alert')
    await sendAlert({
      level: 'critical',
      source: 'stripe',
      title: 'Chargeback / 支付争议',
      message: `收到 chargeback(${dispute.reason})，金额 ${(dispute.amount / 100).toFixed(2)} ${dispute.currency.toUpperCase()}。去 Stripe Dashboard 应诉或接受，并决定是否撤销该用户 Pro。`,
      details: { disputeId: dispute.id, chargeId: charge ?? '—', status: dispute.status },
    })
  } catch (err) {
    logger.error('dispute alert failed (non-fatal)', {
      error: err instanceof Error ? err.message : err,
    })
  }
}
