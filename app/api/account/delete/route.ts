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

    // Stop renewal without destroying a subscription that can still be resumed
    // during the grace period. Lifetime purchases have no Stripe subscription.
    let stripeSubscriptionId: string | null = null
    try {
      const { data: subscription, error: subscriptionError } = await adminSupabase
        .from('subscriptions')
        .select('stripe_subscription_id, status, plan')
        .eq('user_id', user.id)
        .in('status', ['active', 'trialing', 'past_due'])
        .limit(1)
        .maybeSingle()
      if (subscriptionError) throw subscriptionError

      const candidateId = subscription?.stripe_subscription_id ?? null
      const isLifetime = subscription?.plan === 'lifetime' || candidateId?.startsWith('lifetime_')
      if (candidateId && !isLifetime) {
        stripeSubscriptionId = candidateId
        await getStripe().subscriptions.update(candidateId, { cancel_at_period_end: true })
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
      // Compensate the reversible Stripe change when the database transaction
      // fails, so a failed deletion attempt has no billing side effect.
      if (stripeSubscriptionId) {
        try {
          await getStripe().subscriptions.update(stripeSubscriptionId, {
            cancel_at_period_end: false,
          })
        } catch (error) {
          logger.error('Failed to resume subscription after deletion rollback', {
            userId: user.id,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
      logger.error('Account deletion transaction failed', {
        userId: user.id,
        error: scheduleError.message,
      })
      return NextResponse.json(
        { error: 'Failed to schedule account deletion. Please try again.' },
        { status: 500 }
      )
    }

    if (stripeSubscriptionId) {
      await adminSupabase
        .from('subscriptions')
        .update({ cancel_at_period_end: true })
        .eq('user_id', user.id)
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
