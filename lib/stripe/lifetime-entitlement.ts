import 'server-only'

import type Stripe from 'stripe'
import type { SupabaseClient } from '@supabase/supabase-js'
import { PRICING } from '@/app/(app)/user-center/membership-config'
import type { Database, Json } from '@/lib/supabase/database.types'
import {
  resolveCheckoutSessionAuthority,
  StripeAuthorityError,
  type LifetimePaymentAuthority,
} from '@/lib/stripe/entitlement-authority'
import { stripeEntitlementAuthorityOptions } from '@/lib/stripe/entitlement-runtime'

const LIFETIME_PRICE_CENTS = Math.round(PRICING.lifetime.price * 100)
const LIFETIME_CURRENCY = 'usd'

export const LIFETIME_RESERVATION_ID_METADATA_KEY = 'lifetime_reservation_id'
export const LIFETIME_RESERVATION_NONCE_METADATA_KEY = 'lifetime_reservation_nonce'

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const activationStatuses = new Set([
  'activated',
  'already_activated',
  'identity_conflict',
  'manual_review',
  'refunded_payment',
  'reservation_refund_queued',
  'reservation_review',
  'subject_deleted',
  'duplicate_refund_queued',
] as const)

export type LifetimeActivationStatus =
  | 'activated'
  | 'already_activated'
  | 'identity_conflict'
  | 'manual_review'
  | 'refunded_payment'
  | 'reservation_refund_queued'
  | 'reservation_review'
  | 'subject_deleted'
  | 'duplicate_refund_queued'
  | 'authority_review_recorded'

export type LifetimeActivationOutcome = {
  status: LifetimeActivationStatus
  authority?: LifetimePaymentAuthority
  reviewCode?: StripeAuthorityError['code']
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

function reservationIdFromSession(session: Stripe.Checkout.Session): string | null {
  const candidate = session.metadata?.[LIFETIME_RESERVATION_ID_METADATA_KEY]?.trim()
  return candidate && uuidPattern.test(candidate) ? candidate.toLowerCase() : null
}

function reviewContext(error: StripeAuthorityError): Json {
  return JSON.parse(JSON.stringify(error.toReviewPayload())) as Json
}

export async function recordStripeCheckoutManualReview(params: {
  supabase: SupabaseClient<Database>
  objectType?: string
  sessionId: string
  userId: string | null
  reasonKey: string
  reason: string
  context: Json
}): Promise<void> {
  const { supabase, objectType, sessionId, userId, reasonKey, reason, context } = params
  const candidateUserId = userId?.trim()
  const canonicalUserId =
    candidateUserId && uuidPattern.test(candidateUserId) ? candidateUserId.toLowerCase() : null
  const { data, error: reviewError } = await supabase.rpc('record_stripe_manual_review_atomic', {
    p_object_type: objectType || 'checkout_session',
    p_object_id: sessionId,
    p_user_id: canonicalUserId,
    p_reason_key: reasonKey,
    p_reason: reason,
    p_context: context,
  })
  if (reviewError) {
    throw new Error(`Failed to persist Stripe authority review: ${reviewError.message}`)
  }
  const status = rpcStatus(data, 'record_stripe_manual_review_atomic')
  if (status !== 'recorded' && status !== 'already_recorded') {
    throw new Error(`record_stripe_manual_review_atomic returned unexpected status ${status}`)
  }
}

async function recordAuthorityReview(
  supabase: SupabaseClient<Database>,
  sessionId: string,
  userId: string,
  error: StripeAuthorityError
): Promise<void> {
  return recordStripeCheckoutManualReview({
    supabase,
    sessionId,
    userId,
    reasonKey: `checkout_authority:${error.code}`,
    reason: error.message,
    context: reviewContext(error),
  })
}

/**
 * Resolve the full immutable Stripe chain before granting a lifetime
 * entitlement: Checkout Session -> PaymentIntent -> Charge -> configured
 * product. The database RPC then atomically consumes the exact durable seat
 * reservation and records the payment ledger identity.
 */
export async function activateLifetimeCheckoutEntitlement(params: {
  stripe: Stripe
  supabase: SupabaseClient<Database>
  session: Stripe.Checkout.Session
  expectedUserId: string
}): Promise<LifetimeActivationOutcome> {
  let authority: LifetimePaymentAuthority
  try {
    const resolved = await resolveCheckoutSessionAuthority(
      params.stripe,
      params.session,
      stripeEntitlementAuthorityOptions(params.expectedUserId)
    )
    if (resolved.kind !== 'lifetime_payment') {
      throw new Error(`Checkout ${params.session.id} is not a lifetime payment`)
    }
    if (resolved.amount !== LIFETIME_PRICE_CENTS) {
      throw new StripeAuthorityError({
        code: 'amount_mismatch',
        stage: 'product',
        message: 'Lifetime payment does not match the configured product amount.',
        objectIds: {
          sessionId: resolved.sessionId,
          customerId: resolved.customerId,
          paymentIntentId: resolved.paymentIntentId,
          chargeId: resolved.chargeId,
        },
        details: {
          expected_amount: LIFETIME_PRICE_CENTS,
          actual_amount: resolved.amount,
          price_id: resolved.priceId,
        },
      })
    }
    if (resolved.currency !== LIFETIME_CURRENCY) {
      throw new StripeAuthorityError({
        code: 'currency_mismatch',
        stage: 'product',
        message: 'Lifetime payment does not match the configured product currency.',
        objectIds: {
          sessionId: resolved.sessionId,
          customerId: resolved.customerId,
          paymentIntentId: resolved.paymentIntentId,
          chargeId: resolved.chargeId,
        },
        details: {
          expected_currency: LIFETIME_CURRENCY,
          actual_currency: resolved.currency,
          price_id: resolved.priceId,
        },
      })
    }
    authority = resolved
  } catch (error) {
    if (!(error instanceof StripeAuthorityError)) throw error
    await recordAuthorityReview(params.supabase, params.session.id, params.expectedUserId, error)
    return {
      status: 'authority_review_recorded',
      reviewCode: error.code,
    }
  }

  const { data, error } = await params.supabase.rpc(
    'activate_lifetime_membership_with_identity_atomic',
    {
      p_user_id: authority.userId,
      p_stripe_customer_id: authority.customerId,
      p_checkout_session_id: authority.sessionId,
      p_reservation_id: reservationIdFromSession(params.session),
      p_stripe_payment_intent_id: authority.paymentIntentId,
      p_stripe_charge_id: authority.chargeId,
      p_amount_paid: authority.amount,
      p_currency: authority.currency,
      p_paid_at: new Date(authority.paidAt * 1000).toISOString(),
      p_payment_status: 'succeeded',
    }
  )
  if (error) {
    throw new Error(`Failed to activate lifetime entitlement: ${error.message}`)
  }
  const status = rpcStatus(data, 'activate_lifetime_membership_with_identity_atomic')
  if (
    !activationStatuses.has(
      status as Exclude<LifetimeActivationStatus, 'authority_review_recorded'>
    )
  ) {
    throw new Error(
      `activate_lifetime_membership_with_identity_atomic returned unexpected status ${status}`
    )
  }
  return {
    status: status as Exclude<LifetimeActivationStatus, 'authority_review_recorded'>,
    authority,
  }
}

export function lifetimeActivationGranted(status: LifetimeActivationStatus): boolean {
  return status === 'activated' || status === 'already_activated'
}
