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
} from './handlers/refund'
import { getOrCreateCorrelationId, runWithCorrelationId } from '@/lib/api/correlation'
import { env } from '@/lib/env'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

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
      const { data: claimResult, error: claimError } = await supabase.rpc('claim_stripe_event', {
        p_event_id: event.id,
        p_event_type: event.type,
      })

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

      if (claimResult === 'processed') {
        logger.info(`Event ${event.id} already processed, skipping`, { type: event.type })
        return NextResponse.json({ received: true, skipped: true })
      }

      if (claimResult !== 'claimed') {
        // A concurrent delivery owns this event, or the function returned an
        // unknown state. A non-2xx response asks Stripe to retry rather than
        // acknowledging work that has not completed.
        logger.warn('Stripe event is not available for processing', {
          eventId: event.id,
          eventType: event.type,
          claimResult,
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
              await handleCheckoutComplete(session)
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
            await handleSubscriptionUpdate(event.data.object as Stripe.Subscription)
            break

          case 'customer.subscription.deleted':
            await handleSubscriptionCanceled(event.data.object as Stripe.Subscription)
            break

          case 'invoice.paid':
          case 'invoice.payment_succeeded':
            await handlePaymentSucceeded(event.data.object as Stripe.Invoice)
            break

          case 'invoice.payment_failed':
            await handlePaymentFailed(event.data.object as Stripe.Invoice)
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
            })
            break

          // Legacy event adapters remain retryable through the same authority chain.
          case 'charge.refunded':
            await handleChargeRefunded(event.data.object as Stripe.Charge, {
              eventId: event.id,
              eventCreatedAt: event.created,
            })
            break

          case 'charge.refund.updated':
            await handleRefundLifecycle(event.data.object as Stripe.Refund, {
              eventId: event.id,
              eventCreatedAt: event.created,
            })
            break

          case 'customer.subscription.trial_will_end':
            await handleTrialWillEnd(event.data.object as Stripe.Subscription)
            break

          case 'charge.dispute.created':
            await handleChargeDisputeCreated(event.data.object as Stripe.Dispute)
            break

          default:
            logger.info(`Unhandled event type: ${event.type}`)
        }

        const { data: finished, error: finishError } = await supabase.rpc('finish_stripe_event', {
          p_event_id: event.id,
          p_succeeded: true,
          p_error: null,
        })
        if (finishError || finished !== true) {
          throw new Error(finishError?.message || 'Stripe event success state was not persisted')
        }
      } catch (handlerError) {
        const message = handlerError instanceof Error ? handlerError.message : String(handlerError)
        const { error: failureStateError } = await supabase.rpc('finish_stripe_event', {
          p_event_id: event.id,
          p_succeeded: false,
          p_error: message,
        })
        logger.error('Stripe webhook handler failed; event remains retryable', {
          eventId: event.id,
          eventType: event.type,
          error: message,
          failureStateError: failureStateError?.message,
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
