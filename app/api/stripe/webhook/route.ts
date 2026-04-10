import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'
import { constructWebhookEvent } from '@/lib/stripe'
import { getSupabase, logger } from './handlers/shared'
import { handleCheckoutComplete, handleTipPaymentCompleted } from './handlers/checkout'
import { handleSubscriptionUpdate, handleSubscriptionCanceled, handleTrialWillEnd } from './handlers/subscription'
import { handlePaymentSucceeded, handlePaymentFailed } from './handlers/invoice'
import { handleChargeRefunded, handleRefundUpdated } from './handlers/refund'
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

    // Atomic idempotency: INSERT first, skip if duplicate (race-safe)
    const { error: idempotencyError } = await supabase
      .from('stripe_events')
      .insert({
        event_id: event.id,
        event_type: event.type,
        processed_at: new Date().toISOString(),
      })

    if (idempotencyError) {
      // Unique constraint violation = already processed (the safe path)
      if (idempotencyError.code === '23505') {
        logger.info(`Event ${event.id} already processed, skipping`, { type: event.type })
        return NextResponse.json({ received: true, skipped: true })
      }
      // SECURITY (audit P1-9, 2026-04-09): non-23505 errors are transient
      // (DB pool exhaustion, network blip, statement timeout). Returning 500
      // makes Stripe retry the webhook with exponential backoff. The
      // alternative — proceeding without the idempotency row — risks
      // double-processing this event AND any future delivery of the same
      // event_id, which for payment events means double crediting,
      // double-issuing entitlements, double notifications, etc.
      // It is strictly safer to drop a delivery and let Stripe retry than
      // to process without the idempotency guard.
      logger.error('Idempotency insert failed — returning 500 to trigger Stripe retry', {
        eventId: event.id,
        eventType: event.type,
        errorCode: idempotencyError.code,
        errorMessage: idempotencyError.message,
        correlationId,
      })
      return NextResponse.json(
        { error: 'Idempotency check failed, please retry' },
        { status: 500 },
      )
    }

    logger.info(`[Stripe Webhook] Processing ${event.type}`, { eventId: event.id, correlationId })

    // Dispatch to handlers
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session
        if (session.metadata?.type === 'tip') {
          await handleTipPaymentCompleted(session)
        } else {
          await handleCheckoutComplete(session)
        }
        break
      }

      case 'customer.subscription.created':
      case 'customer.subscription.updated':
        await handleSubscriptionUpdate(event.data.object as Stripe.Subscription)
        break

      case 'customer.subscription.deleted':
        await handleSubscriptionCanceled(event.data.object as Stripe.Subscription)
        break

      case 'invoice.payment_succeeded':
        await handlePaymentSucceeded(event.data.object as Stripe.Invoice)
        break

      case 'invoice.payment_failed':
        await handlePaymentFailed(event.data.object as Stripe.Invoice)
        break

      case 'charge.refunded':
        await handleChargeRefunded(event.data.object as Stripe.Charge)
        break

      case 'charge.refund.updated':
        await handleRefundUpdated(event.data.object as Stripe.Refund)
        break

      case 'customer.subscription.trial_will_end':
        await handleTrialWillEnd(event.data.object as Stripe.Subscription)
        break

      default:
        logger.info(`Unhandled event type: ${event.type}`)
    }

    // Event already recorded at start (atomic idempotency)

    const duration = Date.now() - startTime
    logger.info(`[Stripe Webhook] Completed ${event.type} in ${duration}ms`, { eventId: event.id, correlationId, duration })
    return NextResponse.json({ received: true })

  } catch (error: unknown) {
    const duration = Date.now() - startTime
    logger.error('Webhook error', { error, correlationId, duration })
    return NextResponse.json({ error: 'Webhook handler failed' }, { status: 500 })
  }
  }) // end runWithCorrelationId
}
