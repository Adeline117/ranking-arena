import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'
import { constructWebhookEvent } from '@/lib/stripe'
import { getSupabase, logger } from './handlers/shared'
import {
  carriesTipCheckoutIdentity,
  handleCheckoutComplete,
  handleCheckoutExpired,
  handleTipPaymentCompleted,
} from './handlers/checkout'
import {
  handleSubscriptionUpdate,
  handleSubscriptionCanceled,
  handleTrialWillEnd,
} from './handlers/subscription'
import {
  handlePaymentSucceeded,
  handlePaymentFailed,
  handlePaymentActionRequired,
  handleInvoiceFinalizationFailed,
} from './handlers/invoice'
import {
  handleChargeRefunded,
  handleRefundLifecycle,
  handleChargeDisputeCreated,
  handleChargeDisputeFundsWithdrawn,
  handleChargeDisputeFundsReinstated,
} from './handlers/refund'
import { getOrCreateCorrelationId, runWithCorrelationId } from '@/lib/api/correlation'
import { env } from '@/lib/env'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const LEASE_TOKEN_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

type StripeEventClaim =
  | { status: 'claimed'; leaseToken: string }
  | { status: 'processed' }
  | { status: 'busy' | 'identity_conflict' | 'invalid' }

function parseStripeEventClaim(value: unknown): StripeEventClaim {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { status: 'invalid' }
  }
  const candidate = value as Record<string, unknown>
  if (candidate.status === 'processed') return { status: 'processed' }
  if (candidate.status === 'busy' || candidate.status === 'identity_conflict') {
    return { status: candidate.status }
  }
  if (
    candidate.status === 'claimed' &&
    typeof candidate.leaseToken === 'string' &&
    LEASE_TOKEN_PATTERN.test(candidate.leaseToken)
  ) {
    return { status: 'claimed', leaseToken: candidate.leaseToken }
  }
  return { status: 'invalid' }
}

function stripeEventFinishStatus(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const status = (value as Record<string, unknown>).status
  return typeof status === 'string' ? status : null
}

export async function POST(request: NextRequest) {
  const correlationId = getOrCreateCorrelationId(request)
  return runWithCorrelationId(correlationId, async () => {
    const startTime = Date.now()
    if (!env.STRIPE_SECRET_KEY) {
      logger.error('STRIPE_SECRET_KEY is not configured')
      return NextResponse.json({ error: 'Payment system not configured' }, { status: 503 })
    }
    if (!env.STRIPE_WEBHOOK_SECRET) {
      logger.error('STRIPE_WEBHOOK_SECRET is not configured')
      return NextResponse.json({ error: 'Webhook not configured' }, { status: 503 })
    }

    try {
      const body = await request.text()
      const signature = request.headers.get('stripe-signature')

      if (!signature) {
        return NextResponse.json({ error: 'Missing stripe-signature header' }, { status: 400 })
      }

      let event: Stripe.Event
      try {
        event = constructWebhookEvent(body, signature)
      } catch (err: unknown) {
        logger.error('Webhook signature verification failed', { error: err })
        return NextResponse.json({ error: 'Invalid signature' }, { status: 400 })
      }

      const supabase = getSupabase()

      // Atomically claim the event without calling it processed yet. A prior
      // failed (or stale processing) delivery remains claimable on retry.
      const { data: rawClaimResult, error: claimError } = await supabase.rpc(
        'claim_stripe_event_v2',
        {
          p_event_id: event.id,
          p_event_type: event.type,
          p_livemode: event.livemode,
        }
      )

      if (claimError) {
        logger.error('Stripe event claim failed — returning 500 for retry', {
          eventId: event.id,
          eventType: event.type,
          errorCode: claimError.code,
          errorMessage: claimError.message,
          correlationId,
        })
        return NextResponse.json({ error: 'Event claim failed, please retry' }, { status: 500 })
      }

      const claimResult = parseStripeEventClaim(rawClaimResult)

      if (claimResult.status === 'processed') {
        logger.info(`Event ${event.id} already processed, skipping`, { type: event.type })
        return NextResponse.json({ received: true, skipped: true })
      }

      if (claimResult.status !== 'claimed') {
        // A concurrent delivery owns this event, or the function returned an
        // unknown state. A non-2xx response asks Stripe to retry rather than
        // acknowledging work that has not completed.
        logger.warn('Stripe event is not available for processing', {
          eventId: event.id,
          eventType: event.type,
          claimResult: claimResult.status,
        })
        return NextResponse.json({ error: 'Event is already processing' }, { status: 500 })
      }

      logger.info(`[Stripe Webhook] Processing ${event.type}`, { eventId: event.id, correlationId })

      try {
        // Dispatch to handlers
        switch (event.type) {
          case 'checkout.session.completed': {
            const session = event.data.object as Stripe.Checkout.Session
            if (carriesTipCheckoutIdentity(session.metadata)) {
              await handleTipPaymentCompleted(session, {
                id: event.id,
                created: event.created,
                livemode: event.livemode,
              })
            } else {
              await handleCheckoutComplete(session, {
                id: event.id,
                created: event.created,
                livemode: event.livemode,
              })
            }
            break
          }

          case 'checkout.session.expired':
            await handleCheckoutExpired(event.data.object as Stripe.Checkout.Session, {
              id: event.id,
              created: event.created,
              livemode: event.livemode,
            })
            break

          case 'customer.subscription.created':
          case 'customer.subscription.updated':
            await handleSubscriptionUpdate(event.data.object as Stripe.Subscription, {
              id: event.id,
              created: event.created,
              livemode: event.livemode,
            })
            break

          case 'customer.subscription.deleted':
            await handleSubscriptionCanceled(event.data.object as Stripe.Subscription, {
              id: event.id,
              created: event.created,
              livemode: event.livemode,
            })
            break

          case 'invoice.paid':
          case 'invoice.payment_succeeded':
            await handlePaymentSucceeded(event.data.object as Stripe.Invoice, {
              id: event.id,
              created: event.created,
              livemode: event.livemode,
              type: event.type,
            })
            break

          case 'invoice.payment_failed':
            await handlePaymentFailed(event.data.object as Stripe.Invoice, {
              id: event.id,
              created: event.created,
              livemode: event.livemode,
              type: 'invoice.payment_failed',
            })
            break

          case 'invoice.payment_action_required':
            await handlePaymentActionRequired(event.data.object as Stripe.Invoice)
            break

          case 'invoice.finalization_failed':
            await handleInvoiceFinalizationFailed(event.data.object as Stripe.Invoice)
            break

          case 'refund.created':
          case 'refund.updated':
          case 'refund.failed':
            await handleRefundLifecycle(event.data.object as Stripe.Refund, {
              eventId: event.id,
              eventCreatedAt: event.created,
              livemode: event.livemode,
            })
            break

          // Legacy event adapters remain retryable through the same authority chain.
          case 'charge.refunded':
            await handleChargeRefunded(event.data.object as Stripe.Charge, {
              eventId: event.id,
              eventCreatedAt: event.created,
              livemode: event.livemode,
            })
            break

          case 'charge.refund.updated':
            await handleRefundLifecycle(event.data.object as Stripe.Refund, {
              eventId: event.id,
              eventCreatedAt: event.created,
              livemode: event.livemode,
            })
            break

          case 'customer.subscription.trial_will_end':
            await handleTrialWillEnd(event.data.object as Stripe.Subscription)
            break

          case 'charge.dispute.created':
            await handleChargeDisputeCreated(event.data.object as Stripe.Dispute, {
              eventId: event.id,
              eventCreatedAt: event.created,
              livemode: event.livemode,
            })
            break

          case 'charge.dispute.funds_withdrawn':
            await handleChargeDisputeFundsWithdrawn(event.data.object as Stripe.Dispute, {
              eventId: event.id,
              eventCreatedAt: event.created,
              livemode: event.livemode,
            })
            break

          case 'charge.dispute.funds_reinstated':
            await handleChargeDisputeFundsReinstated(event.data.object as Stripe.Dispute, {
              eventId: event.id,
              eventCreatedAt: event.created,
              livemode: event.livemode,
            })
            break

          default:
            logger.info(`Unhandled event type: ${event.type}`)
        }

        const { data: finished, error: finishError } = await supabase.rpc(
          'finish_stripe_event_v2',
          {
            p_event_id: event.id,
            p_event_type: event.type,
            p_livemode: event.livemode,
            p_lease_token: claimResult.leaseToken,
            p_succeeded: true,
            p_error: null,
          }
        )
        if (finishError || stripeEventFinishStatus(finished) !== 'processed') {
          throw new Error(finishError?.message || 'Stripe event success state was not persisted')
        }
      } catch (handlerError) {
        const rawMessage =
          handlerError instanceof Error ? handlerError.message : String(handlerError)
        const message = rawMessage.trim().slice(0, 2000) || 'unknown handler failure'
        const { data: failed, error: failureStateError } = await supabase.rpc(
          'finish_stripe_event_v2',
          {
            p_event_id: event.id,
            p_event_type: event.type,
            p_livemode: event.livemode,
            p_lease_token: claimResult.leaseToken,
            p_succeeded: false,
            p_error: message,
          }
        )
        logger.error('Stripe webhook handler failed; event remains retryable', {
          eventId: event.id,
          eventType: event.type,
          error: message,
          failureStateError: failureStateError?.message,
          failureStateStatus: stripeEventFinishStatus(failed),
          correlationId,
        })
        return NextResponse.json({ error: 'Webhook handler failed' }, { status: 500 })
      }

      const duration = Date.now() - startTime
      logger.info(`[Stripe Webhook] Completed ${event.type} in ${duration}ms`, {
        eventId: event.id,
        correlationId,
        duration,
      })
      return NextResponse.json({ received: true })
    } catch (error: unknown) {
      const duration = Date.now() - startTime
      logger.error('Webhook error', { error, correlationId, duration })
      return NextResponse.json({ error: 'Webhook handler failed' }, { status: 500 })
    }
  }) // end runWithCorrelationId
}
