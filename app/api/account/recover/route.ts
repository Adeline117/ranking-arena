/** Recover an account during its 30-day deletion grace period. */

import { createHash, randomUUID } from 'node:crypto'
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
  discoverStripeSubscriptionBilling,
  resumeStripeSubscriptionRenewals,
  stopStripeSubscriptionRenewals,
} from '@/lib/stripe/account-deletion'

const logger = createLogger('account-recover')
const INVALID_RECOVERY = 'Invalid credentials or no pending deletion'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

async function reban(userId: string): Promise<boolean> {
  const { error } = await getSupabaseAdmin().auth.admin.updateUserById(userId, {
    ban_duration: '720h',
  })
  if (error) {
    logger.error('Failed to restore deletion ban after recovery failure', { userId, error })
    return false
  }
  return true
}

type RecoveryClaimAck = 'claimed' | 'busy' | 'finished' | 'invalid'
type RecoveryFinishAck = 'finished' | 'aborted' | 'absent' | 'invalid'
type RecoveryAbortAck = 'aborted' | 'finished' | 'absent'

interface RecoveryRpcResult {
  data: unknown
  error: { message: string } | null
}

async function recoveryRpc(
  functionName: string,
  args: Record<string, unknown>
): Promise<RecoveryRpcResult> {
  const admin = getSupabaseAdmin()
  return (await Reflect.apply(admin.rpc, admin, [functionName, args])) as RecoveryRpcResult
}

async function claimRecoveryAdmission(params: {
  userId: string
  recoveryTokenHash: string | null
  operationId: string
}): Promise<RecoveryClaimAck> {
  const { data, error } = await recoveryRpc('claim_account_recovery_admission_atomic', {
    p_user_id: params.userId,
    p_recovery_token_hash: params.recoveryTokenHash,
    p_operation_id: params.operationId,
  })
  if (
    error ||
    (data !== 'claimed' && data !== 'busy' && data !== 'finished' && data !== 'invalid')
  ) {
    throw new Error(error?.message ?? 'Recovery admission returned an invalid acknowledgement')
  }
  return data
}

async function finishRecoveryAdmission(params: {
  userId: string
  operationId: string
}): Promise<RecoveryFinishAck> {
  const { data, error } = await recoveryRpc('finish_account_recovery_admission_atomic', {
    p_user_id: params.userId,
    p_operation_id: params.operationId,
  })
  if (
    error ||
    (data !== 'finished' && data !== 'aborted' && data !== 'absent' && data !== 'invalid')
  ) {
    throw new Error(error?.message ?? 'Recovery finish returned an invalid acknowledgement')
  }
  return data
}

async function abortRecoveryAdmission(params: {
  userId: string
  operationId: string
}): Promise<RecoveryAbortAck> {
  const { data, error } = await recoveryRpc('abort_account_recovery_admission_atomic', {
    p_user_id: params.userId,
    p_operation_id: params.operationId,
  })
  if (error || (data !== 'aborted' && data !== 'finished' && data !== 'absent')) {
    throw new Error(error?.message ?? 'Recovery abort returned an invalid acknowledgement')
  }
  return data
}

async function abortRecoveryAdmissionBestEffort(params: {
  userId: string
  operationId: string
}): Promise<RecoveryAbortAck | null> {
  try {
    const ack = await abortRecoveryAdmission(params)
    if (ack === 'finished') {
      logger.error('Recovery abort observed an already-finished admission', params)
    }
    return ack
  } catch (error) {
    logger.error('Failed to abort account recovery admission', {
      ...params,
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}

interface BillingRecoveryState {
  customerId: string | null
  consumerSubscriptionId: string | null
  resumedSubscriptionIds: string[]
  terminalSubscriptionIds: string[]
}

function isExactCustomerBindingAck(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const ack = value as Record<string, unknown>
  return (
    Object.keys(ack).length === 1 &&
    Object.prototype.hasOwnProperty.call(ack, 'status') &&
    (ack.status === 'bound' || ack.status === 'already_bound')
  )
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

  const stripeClient = getStripe()
  let stripeCustomerId = billingProfile.stripe_customer_id
  if (!stripeCustomerId) {
    const discovery = await discoverStripeSubscriptionBilling({
      stripeClient,
      subscriptionIds,
      expectedUserId: userId,
      includeCustomerSubscriptions: true,
    })
    if (!discovery.customerId) {
      throw new Error('Stripe customer identity could not be proven for account recovery')
    }
    const { data: bindAck, error: bindError } = await admin.rpc(
      'bind_stripe_customer_owner_atomic',
      {
        p_user_id: userId,
        p_new_stripe_customer_id: discovery.customerId,
        p_expected_previous_stripe_customer_id: null,
      }
    )
    if (bindError || !isExactCustomerBindingAck(bindAck)) {
      throw new Error('Stripe customer ownership could not be bound for account recovery')
    }
    stripeCustomerId = discovery.customerId
  }

  const resumed = await resumeStripeSubscriptionRenewals({
    stripeClient,
    subscriptionIds,
    expectedCustomerId: stripeCustomerId,
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
      await stopUncommittedBillingRecovery(userId, recovery)
      throw updateError
    }
  }
  return recovery
}

async function stopUncommittedBillingRecovery(
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
    }

    if (!userId) {
      return NextResponse.json({ success: false, error: INVALID_RECOVERY }, { status: 401 })
    }

    // The claim is the cross-system serialization point. No Auth or Stripe
    // mutation is permitted before an exact single-winner acknowledgement.
    const operationId = randomUUID()
    let claimAck: RecoveryClaimAck
    try {
      claimAck = await claimRecoveryAdmission({
        userId,
        recoveryTokenHash: recoveryTokenHash ?? null,
        operationId,
      })
    } catch (error) {
      await abortRecoveryAdmissionBestEffort({ userId, operationId })
      logger.error('Failed to claim account recovery admission', {
        userId,
        operationId,
        error: error instanceof Error ? error.message : String(error),
      })
      return NextResponse.json(
        { success: false, error: 'Recovery is temporarily unavailable. Please try again.' },
        { status: 503 }
      )
    }
    if (claimAck === 'busy') {
      return NextResponse.json(
        { success: false, error: 'Account recovery is already in progress.' },
        { status: 409 }
      )
    }
    if (claimAck !== 'claimed') {
      return NextResponse.json({ success: false, error: INVALID_RECOVERY }, { status: 401 })
    }

    // Password verification requires a short Auth window. Close it again
    // before the PostgreSQL finish transition so an ambiguous finish always
    // leaves the subject banned rather than racing an active session.
    if (!recoveryTokenHash) {
      const email = body.email!
      const password = body.password!
      const { error: verificationUnbanError } = await admin.auth.admin.updateUserById(userId, {
        ban_duration: 'none',
      })
      if (verificationUnbanError) {
        await reban(userId)
        await abortRecoveryAdmissionBestEffort({ userId, operationId })
        logger.error('Failed to open credential verification window', {
          userId,
          verificationUnbanError,
        })
        return NextResponse.json({ success: false, error: 'Recovery failed.' }, { status: 500 })
      }

      const anon = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY)
      const { error: signInError } = await anon.auth.signInWithPassword({ email, password })
      const banRestored = await reban(userId)
      if (!banRestored) {
        await abortRecoveryAdmissionBestEffort({ userId, operationId })
        return NextResponse.json({ success: false, error: 'Recovery failed.' }, { status: 500 })
      }
      if (signInError) {
        await abortRecoveryAdmissionBestEffort({ userId, operationId })
        return NextResponse.json({ success: false, error: INVALID_RECOVERY }, { status: 401 })
      }
    }

    let finishAck: RecoveryFinishAck
    try {
      finishAck = await finishRecoveryAdmission({ userId, operationId })
    } catch (error) {
      const resolution = await abortRecoveryAdmissionBestEffort({ userId, operationId })
      logger.error('Failed to finish account recovery admission', {
        userId,
        operationId,
        error: error instanceof Error ? error.message : String(error),
        resolution,
      })
      if (resolution !== 'finished') {
        return NextResponse.json(
          { success: false, error: 'Recovery is temporarily unavailable. Please try again.' },
          { status: 503 }
        )
      }
      finishAck = 'finished'
    }
    if (finishAck !== 'finished') {
      await abortRecoveryAdmissionBestEffort({ userId, operationId })
      logger.error('Account recovery admission did not finish', {
        userId,
        operationId,
        finishAck,
      })
      return NextResponse.json({ success: false, error: INVALID_RECOVERY }, { status: 401 })
    }

    const { error: finalUnbanError } = await admin.auth.admin.updateUserById(userId, {
      ban_duration: 'none',
    })
    if (finalUnbanError) {
      logger.error('Account restored but final Auth unban failed', {
        userId,
        operationId,
        finalUnbanError,
      })
      return NextResponse.json({ success: false, error: 'Recovery failed.' }, { status: 500 })
    }

    let billingRecovery: BillingRecoveryState
    try {
      billingRecovery = await resumeSubscription(userId)
    } catch (error) {
      logger.error('Account recovered but subscription renewal could not be resumed', {
        userId,
        operationId,
        error: error instanceof Error ? error.message : String(error),
      })
      return NextResponse.json({
        success: true,
        subscription_resumed: false,
        billing_reactivation_required: true,
        message:
          'Account and retained data recovered, but billing must be reactivated from account settings.',
      })
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
