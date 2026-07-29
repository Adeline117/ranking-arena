/** Recover an account during its 30-day deletion grace period. */

import { createHash } from 'node:crypto'
import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { withPublic } from '@/lib/api/middleware'
import { badRequest } from '@/lib/api/response'
import { isAccountRecoveryToken } from '@/lib/auth/account-recovery-token'
import { env } from '@/lib/env'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { createLogger } from '@/lib/utils/logger'
import { getStripe } from '@/lib/stripe'
import {
  resumeStripeSubscriptionRenewals,
  stopStripeSubscriptionRenewals,
} from '@/lib/stripe/account-deletion'

const logger = createLogger('account-recover')
const INVALID_RECOVERY = 'Invalid credentials or no pending deletion'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

async function reban(userId: string): Promise<void> {
  const { error } = await getSupabaseAdmin().auth.admin.updateUserById(userId, {
    ban_duration: '720h',
  })
  if (error)
    logger.error('Failed to restore deletion ban after recovery failure', { userId, error })
}

interface BillingRecoveryState {
  customerId: string | null
  consumerSubscriptionId: string | null
  resumedSubscriptionIds: string[]
  terminalSubscriptionIds: string[]
}

async function resumeSubscription(userId: string): Promise<BillingRecoveryState> {
  const admin = getSupabaseAdmin()
  const { data: billingProfile, error: billingProfileError } = await admin
    .from('user_profiles')
    .select('stripe_customer_id, api_stripe_subscription_id')
    .eq('id', userId)
    .maybeSingle()
  if (billingProfileError) throw billingProfileError
  if (!billingProfile) throw new Error('Billing profile not found')

  const { data: subscription, error } = await admin
    .from('subscriptions')
    .select('stripe_subscription_id, status, plan, cancel_at_period_end')
    .eq('user_id', userId)
    .in('status', [
      'active',
      'trialing',
      'past_due',
      'incomplete',
      'unpaid',
      'paused',
      'canceled',
      'incomplete_expired',
    ])
    .limit(1)
    .maybeSingle()
  if (error) throw error

  const subscriptionId = subscription?.stripe_subscription_id ?? null
  const isLifetime = subscription?.plan === 'lifetime' || subscriptionId?.startsWith('lifetime_')
  const consumerSubscriptionId = subscriptionId && !isLifetime ? subscriptionId : null
  const subscriptionIds = [
    consumerSubscriptionId,
    billingProfile.api_stripe_subscription_id,
  ].filter((id): id is string => !!id)
  const hasStripeBillingSurface = !!billingProfile.stripe_customer_id || subscriptionIds.length > 0
  if (!hasStripeBillingSurface) {
    return {
      customerId: null,
      consumerSubscriptionId,
      resumedSubscriptionIds: [],
      terminalSubscriptionIds: [],
    }
  }

  const resumed = await resumeStripeSubscriptionRenewals({
    stripeClient: getStripe(),
    subscriptionIds,
    expectedCustomerId: billingProfile.stripe_customer_id,
    includeCustomerSubscriptions: true,
    pauseMarker: userId,
  })
  const recovery = {
    customerId: resumed.customerId,
    consumerSubscriptionId,
    resumedSubscriptionIds: resumed.changedSubscriptionIds,
    terminalSubscriptionIds: resumed.terminalMarkedSubscriptionIds,
  }
  if (consumerSubscriptionId && resumed.changedSubscriptionIds.includes(consumerSubscriptionId)) {
    const { error: updateError } = await admin
      .from('subscriptions')
      .update({ cancel_at_period_end: false })
      .eq('stripe_subscription_id', consumerSubscriptionId)
      .eq('user_id', userId)
    if (updateError) {
      await restoreDeletionBillingShutdown(userId, recovery)
      throw updateError
    }
  }
  return recovery
}

async function restoreDeletionBillingShutdown(
  userId: string,
  recovery: BillingRecoveryState
): Promise<void> {
  if (recovery.resumedSubscriptionIds.length === 0) return
  const admin = getSupabaseAdmin()
  await stopStripeSubscriptionRenewals({
    stripeClient: getStripe(),
    subscriptionIds: recovery.resumedSubscriptionIds,
    expectedCustomerId: recovery.customerId,
    deletionMode: 'permanent',
    includeCustomerSubscriptions: true,
  })
  if (
    recovery.consumerSubscriptionId &&
    recovery.resumedSubscriptionIds.includes(recovery.consumerSubscriptionId)
  ) {
    const { error } = await admin
      .from('subscriptions')
      .update({ status: 'canceled', cancel_at_period_end: false })
      .eq('stripe_subscription_id', recovery.consumerSubscriptionId)
      .eq('user_id', userId)
    if (error) throw error
  }
}

export const POST = withPublic(
  async ({ request }) => {
    let body: { email?: string; password?: string; recovery_token?: string }
    try {
      body = await request.json()
    } catch {
      return badRequest('Invalid JSON body')
    }

    const hasRecoveryToken = Object.prototype.hasOwnProperty.call(body, 'recovery_token')
    let recoveryToken: string | null = null
    if (hasRecoveryToken) {
      if (!isAccountRecoveryToken(body.recovery_token)) {
        return NextResponse.json({ success: false, error: INVALID_RECOVERY }, { status: 401 })
      }
      recoveryToken = body.recovery_token
    }

    const admin = getSupabaseAdmin()
    let userId: string | null = null
    let recoveryTokenHash: string | undefined

    if (recoveryToken) {
      recoveryTokenHash = createHash('sha256').update(recoveryToken).digest('hex')
      const { data: tokenRow, error } = await admin
        .from('account_recovery_tokens')
        .select('user_id, expires_at, used_at')
        .eq('token_hash', recoveryTokenHash)
        .maybeSingle()

      if (error || !tokenRow || tokenRow.used_at) {
        return NextResponse.json({ success: false, error: INVALID_RECOVERY }, { status: 401 })
      }
      if (new Date(tokenRow.expires_at).getTime() <= Date.now()) {
        return NextResponse.json(
          { success: false, error: 'Recovery period has expired.' },
          { status: 410 }
        )
      }
      userId = tokenRow.user_id
    } else {
      const { email, password } = body
      if (!email || !password) return badRequest('Email and password are required')

      const { data: profile, error } = await admin
        .from('user_profiles')
        .select('id, deletion_scheduled_at')
        .eq('email', email)
        .not('deleted_at', 'is', null)
        .maybeSingle()

      if (error || !profile) {
        return NextResponse.json({ success: false, error: INVALID_RECOVERY }, { status: 401 })
      }
      if (
        profile.deletion_scheduled_at &&
        new Date(profile.deletion_scheduled_at).getTime() <= Date.now()
      ) {
        return NextResponse.json(
          { success: false, error: 'Recovery period has expired.' },
          { status: 410 }
        )
      }

      userId = profile.id
      const { error: unbanError } = await admin.auth.admin.updateUserById(userId, {
        ban_duration: 'none',
      })
      if (unbanError) {
        logger.error('Failed to open credential verification window', { userId, unbanError })
        return NextResponse.json({ success: false, error: 'Recovery failed.' }, { status: 500 })
      }

      let valid = false
      try {
        const anon = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY)
        const { error: signInError } = await anon.auth.signInWithPassword({ email, password })
        valid = !signInError
      } finally {
        if (!valid) await reban(userId)
      }
      if (!valid) {
        return NextResponse.json({ success: false, error: INVALID_RECOVERY }, { status: 401 })
      }
    }

    // Token holders also need the auth ban lifted before the account becomes
    // usable again. A failed DB restore is compensated by re-banning below.
    if (recoveryTokenHash) {
      const { error: unbanError } = await admin.auth.admin.updateUserById(userId, {
        ban_duration: 'none',
      })
      if (unbanError) {
        logger.error('Failed to unban token recovery', { userId, unbanError })
        return NextResponse.json({ success: false, error: 'Recovery failed.' }, { status: 500 })
      }
    }

    let billingRecovery: BillingRecoveryState
    try {
      billingRecovery = await resumeSubscription(userId)
    } catch (error) {
      await reban(userId)
      logger.error('Subscription renewal could not be resumed; account remains pending deletion', {
        userId,
        error: error instanceof Error ? error.message : String(error),
      })
      return NextResponse.json(
        { success: false, error: 'Recovery is temporarily unavailable. Please try again.' },
        { status: 503 }
      )
    }

    const { data: restoredUserId, error: restoreError } = await admin.rpc(
      'restore_pending_account',
      {
        p_user_id: userId,
        ...(recoveryTokenHash ? { p_recovery_token_hash: recoveryTokenHash } : {}),
      }
    )

    if (restoreError || !restoredUserId) {
      try {
        await restoreDeletionBillingShutdown(userId, billingRecovery)
      } catch (error) {
        logger.error('Failed to restore billing pause after account recovery rollback', {
          userId,
          error: error instanceof Error ? error.message : String(error),
        })
      }
      await reban(userId)
      logger.error('Failed to restore pending account', {
        userId,
        error: restoreError?.message ?? 'expired or invalid recovery',
      })
      return NextResponse.json({ success: false, error: 'Recovery failed.' }, { status: 500 })
    }

    logger.info('Account recovered successfully', { userId })
    const subscriptionResumed = billingRecovery.terminalSubscriptionIds.length === 0

    return NextResponse.json({
      success: true,
      subscription_resumed: subscriptionResumed,
      billing_reactivation_required: !subscriptionResumed,
      message: subscriptionResumed
        ? 'Account and retained data recovered successfully. You can now log in.'
        : 'Account recovered, but one or more subscriptions ended during deletion and must be reactivated.',
    })
  },
  { name: 'account-recover', rateLimit: 'sensitive', skipCsrf: true }
)
