/**
 * Schedule account deletion with a real 30-day recovery window.
 * Related account data is retained until the hard-delete cron runs.
 */

import { createHash, randomBytes } from 'node:crypto'
import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { withAuth } from '@/lib/api/middleware'
import { badRequest, forbidden } from '@/lib/api/response'
import { env } from '@/lib/env'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { createLogger } from '@/lib/utils/logger'
import { getStripe } from '@/lib/stripe'
import {
  expireOpenSubscriptionCheckouts,
  stopStripeSubscriptionRenewals,
} from '@/lib/stripe/account-deletion'

const logger = createLogger('account-delete')

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const POST = withAuth(
  async ({ user, request }) => {
    let body: { password?: string; reason?: string; confirm?: string }
    try {
      body = await request.json()
    } catch {
      return badRequest('Invalid JSON body')
    }

    const { password, reason, confirm } = body
    const providers = (user.identities ?? []).map((identity) => identity.provider)
    const isWalletEmail = (user.email ?? '').endsWith('@wallet.arena')
    const hasPassword = !isWalletEmail && providers.includes('email')

    if (hasPassword) {
      if (!password) return badRequest('Password required')
      const anonClient = createClient(
        env.NEXT_PUBLIC_SUPABASE_URL,
        env.NEXT_PUBLIC_SUPABASE_ANON_KEY
      )
      const { error } = await anonClient.auth.signInWithPassword({
        email: user.email!,
        password,
      })
      if (error) return forbidden('Invalid password')
    } else if ((confirm ?? '').trim().toUpperCase() !== 'DELETE') {
      return badRequest('Type DELETE to confirm account deletion')
    }

    const adminSupabase = getSupabaseAdmin()
    const now = new Date()
    const scheduledDeletion = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1_000)
    const recoveryToken = randomBytes(32).toString('base64url')
    const recoveryTokenHash = createHash('sha256').update(recoveryToken).digest('hex')

    // Stop every recurring billing surface before writing the deletion
    // tombstone. API-tier billing is stored on user_profiles, independently of
    // the consumer Pro row in subscriptions. Open subscription Checkout
    // Sessions must also be expired or they can create a first charge later.
    let recurringSubscriptionId: string | null = null
    try {
      const { data: billingProfile, error: billingProfileError } = await adminSupabase
        .from('user_profiles')
        .select('stripe_customer_id, api_stripe_subscription_id')
        .eq('id', user.id)
        .maybeSingle()
      if (billingProfileError) throw billingProfileError
      if (!billingProfile) throw new Error('Billing profile not found')

      const { data: subscription, error: subscriptionError } = await adminSupabase
        .from('subscriptions')
        .select('stripe_subscription_id, status, plan')
        .eq('user_id', user.id)
        .in('status', ['active', 'trialing', 'past_due', 'incomplete', 'unpaid', 'paused'])
        .limit(1)
        .maybeSingle()
      if (subscriptionError) throw subscriptionError

      const candidateId = subscription?.stripe_subscription_id ?? null
      const isLifetime = subscription?.plan === 'lifetime' || candidateId?.startsWith('lifetime_')
      if (candidateId && !isLifetime) {
        recurringSubscriptionId = candidateId
      }

      const subscriptionIds = [recurringSubscriptionId, billingProfile.api_stripe_subscription_id]
      const hasStripeBillingSurface =
        !!billingProfile.stripe_customer_id || subscriptionIds.some(Boolean)

      if (hasStripeBillingSurface) {
        const stripeClient = getStripe()
        if (billingProfile.stripe_customer_id) {
          const checkoutResult = await expireOpenSubscriptionCheckouts({
            stripeClient,
            customerId: billingProfile.stripe_customer_id,
          })
          subscriptionIds.push(...checkoutResult.racedSubscriptionIds)
        }

        const stopped = await stopStripeSubscriptionRenewals({
          stripeClient,
          subscriptionIds,
          expectedCustomerId: billingProfile.stripe_customer_id,
          deletionMode: 'recoverable',
          pauseMarker: user.id,
        })

        if (!billingProfile.stripe_customer_id && stopped.customerId) {
          const checkoutResult = await expireOpenSubscriptionCheckouts({
            stripeClient,
            customerId: stopped.customerId,
          })
          if (checkoutResult.racedSubscriptionIds.length > 0) {
            await stopStripeSubscriptionRenewals({
              stripeClient,
              subscriptionIds: checkoutResult.racedSubscriptionIds,
              expectedCustomerId: stopped.customerId,
              deletionMode: 'recoverable',
              pauseMarker: user.id,
            })
          }
        }
      }
    } catch (error) {
      logger.error('Failed to stop subscription renewal; deletion not scheduled', {
        userId: user.id,
        error: error instanceof Error ? error.message : String(error),
      })
      return NextResponse.json(
        { error: 'Could not stop subscription renewal. Account deletion was not scheduled.' },
        { status: 502 }
      )
    }

    const { error: scheduleError } = await adminSupabase.rpc('schedule_account_deletion', {
      p_user_id: user.id,
      p_reason: reason ?? '',
      p_scheduled_at: scheduledDeletion.toISOString(),
      p_recovery_token_hash: recoveryTokenHash,
    })

    if (scheduleError) {
      // Immediate Stripe cancellation is deliberately irreversible: reviving
      // it here could restart Smart Retries while deletion state is uncertain.
      logger.error('Account deletion transaction failed', {
        userId: user.id,
        error: scheduleError.message,
      })
      return NextResponse.json(
        { error: 'Failed to schedule account deletion. Please try again.' },
        { status: 500 }
      )
    }

    if (recurringSubscriptionId) {
      const { error: localSubscriptionError } = await adminSupabase
        .from('subscriptions')
        .update({ status: 'canceled', cancel_at_period_end: false })
        .eq('stripe_subscription_id', recurringSubscriptionId)
        .eq('user_id', user.id)
      if (localSubscriptionError) {
        logger.error('Remote subscription canceled but local projection update failed', {
          userId: user.id,
          error: localSubscriptionError.message,
        })
      }
    }

    const { error: banError } = await adminSupabase.auth.admin.updateUserById(user.id, {
      ban_duration: '720h',
    })
    const { error: signOutError } = await adminSupabase.auth.admin.signOut(user.id, 'global')
    if (banError || signOutError) {
      // `deleted_at` is independently enforced by server auth, so access stays
      // blocked even if Supabase session invalidation is temporarily degraded.
      logger.error('Account scheduled but auth invalidation was incomplete', {
        userId: user.id,
        banError: banError?.message,
        signOutError: signOutError?.message,
      })
    }

    logger.info('Account deletion scheduled', { userId: user.id })
    return NextResponse.json({
      success: true,
      deletion_scheduled_at: scheduledDeletion.toISOString(),
      recovery_token: recoveryToken,
      message: 'Account marked for deletion, recoverable within 30 days',
    })
  },
  { name: 'account-delete', rateLimit: 'sensitive' }
)
