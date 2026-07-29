/**
 * Schedule account deletion with a real 30-day recovery window.
 * Related account data is retained until the hard-delete cron runs.
 */

import { createHash } from 'node:crypto'
import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { withAuth } from '@/lib/api/middleware'
import { badRequest, forbidden } from '@/lib/api/response'
import { env } from '@/lib/env'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { createLogger } from '@/lib/utils/logger'
import { getStripe } from '@/lib/stripe'
import {
  discoverStripeSubscriptionBilling,
  expireOpenSubscriptionCheckouts,
  stopStripeSubscriptionRenewals,
  type AccountDeletionOneTimeSettlementObservation,
} from '@/lib/stripe/account-deletion'
import { persistAccountDeletionOneTimeSettlementScan } from '@/lib/stripe/account-deletion-settlement'
import { isAccountRecoveryToken } from '@/lib/auth/account-recovery-token'

const logger = createLogger('account-delete')

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface ScheduleDeletionWithBillingBlocksArgs {
  p_user_id: string
  p_reason: string
  p_scheduled_at: string
  p_recovery_token_hash: string
  p_stripe_customer_id: string | null
  p_stripe_subscription_ids: string[]
}

interface ScheduleDeletionWithBillingBlocksResult {
  data: unknown
  error: { message: string } | null
}

const SCHEDULE_DELETION_ACK_KEYS = [
  'status',
  'user_id',
  'deleted_at',
  'deletion_scheduled_at',
  'stripe_customer_id',
  'stripe_subscription_ids',
].sort()

function isIsoTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value))
  )
}

function isExactScheduleDeletionAck(
  value: unknown,
  expected: {
    userId: string
    scheduledAt: string
    stripeCustomerId: string | null
    stripeSubscriptionIds: string[]
  }
): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const ack = value as Record<string, unknown>
  const keys = Object.keys(ack).sort()
  if (
    keys.length !== SCHEDULE_DELETION_ACK_KEYS.length ||
    keys.some((key, index) => key !== SCHEDULE_DELETION_ACK_KEYS[index])
  ) {
    return false
  }

  if (
    ack.status !== 'scheduled' ||
    ack.user_id !== expected.userId ||
    ack.deletion_scheduled_at !== expected.scheduledAt ||
    ack.stripe_customer_id !== expected.stripeCustomerId ||
    !isIsoTimestamp(ack.deleted_at) ||
    Date.parse(ack.deleted_at) > Date.parse(expected.scheduledAt)
  ) {
    return false
  }

  if (
    !Array.isArray(ack.stripe_subscription_ids) ||
    ack.stripe_subscription_ids.some((id) => typeof id !== 'string')
  ) {
    return false
  }
  const receivedIds = ack.stripe_subscription_ids as string[]
  const normalizedIds = [...new Set(receivedIds)].sort()
  return (
    receivedIds.length === normalizedIds.length &&
    receivedIds.every((id, index) => id === normalizedIds[index]) &&
    receivedIds.length === expected.stripeSubscriptionIds.length &&
    receivedIds.every((id, index) => id === expected.stripeSubscriptionIds[index])
  )
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

export const POST = withAuth(
  async ({ user, request }) => {
    let body: {
      password?: string
      reason?: string
      confirm?: string
      recovery_token?: string
    }
    try {
      body = await request.json()
    } catch {
      return badRequest('Invalid JSON body')
    }

    const { password, reason, confirm } = body
    const recoveryToken = body.recovery_token
    if (!isAccountRecoveryToken(recoveryToken)) {
      return badRequest('Invalid recovery credential')
    }
    const providers = new Set(
      (user.identities ?? [])
        .map((identity) => identity.provider)
        .filter(
          (provider): provider is string => typeof provider === 'string' && provider.length > 0
        )
    )
    const metadataProvider = user.app_metadata?.provider
    if (typeof metadataProvider === 'string' && metadataProvider.length > 0) {
      providers.add(metadataProvider)
    }
    const metadataProviders = user.app_metadata?.providers
    if (Array.isArray(metadataProviders)) {
      for (const provider of metadataProviders) {
        if (typeof provider === 'string' && provider.length > 0) providers.add(provider)
      }
    }
    const isWalletEmail = (user.email ?? '').endsWith('@wallet.arena')
    const hasPassword = !isWalletEmail && providers.has('email')

    // `identities` is optional in the Auth user shape. Missing provider data
    // must not silently downgrade a password account to typed confirmation.
    if (!isWalletEmail && providers.size === 0) {
      return forbidden('Unable to verify account authentication method')
    }

    if (hasPassword) {
      if (typeof password !== 'string' || password.length === 0 || password.length > 4096) {
        return badRequest('Password required')
      }
      if (typeof user.email !== 'string' || user.email.length === 0) {
        return forbidden('Unable to verify account password')
      }
      const anonClient = createClient(
        env.NEXT_PUBLIC_SUPABASE_URL,
        env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
        { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }
      )
      const { data: signInData, error } = await anonClient.auth.signInWithPassword({
        email: user.email,
        password,
      })
      if (error || signInData.user?.id !== user.id || signInData.session?.user.id !== user.id) {
        return forbidden('Invalid password')
      }
    } else if ((confirm ?? '').trim().toUpperCase() !== 'DELETE') {
      return badRequest('Type DELETE to confirm account deletion')
    }

    const adminSupabase = getSupabaseAdmin()
    const now = new Date()
    const scheduledDeletion = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1_000)
    // The client staged this exact credential before dispatch, so a successful
    // database commit cannot strand the account when the response is lost.
    // Legacy bundles fail above before any billing/database mutation and can
    // safely retry after refreshing their code.
    const recoveryTokenHash = createHash('sha256').update(recoveryToken).digest('hex')

    // Stop every recurring billing surface before writing the deletion
    // tombstone. API-tier billing is stored on user_profiles, independently of
    // the consumer Pro row in subscriptions. Open subscription Checkout
    // Sessions must also be expired or they can create a first charge later.
    let recurringSubscriptionId: string | null = null
    let stripeCustomerId: string | null = null
    const observedStripeSubscriptionIds = new Set<string>()
    const oneTimeSettlements = new Map<string, AccountDeletionOneTimeSettlementObservation>()
    const mergeOneTimeSettlements = (
      observations: AccountDeletionOneTimeSettlementObservation[]
    ): void => {
      for (const observation of observations) {
        const existing = oneTimeSettlements.get(observation.checkoutSessionId)
        if (existing && JSON.stringify(existing) !== JSON.stringify(observation)) {
          throw new Error('Stripe one-time Checkout settlement changed during account deletion')
        }
        oneTimeSettlements.set(observation.checkoutSessionId, observation)
      }
    }
    try {
      const { data: billingProfile, error: billingProfileError } = await adminSupabase
        .from('user_profiles')
        .select('stripe_customer_id, api_stripe_subscription_id')
        .eq('id', user.id)
        .maybeSingle()
      if (billingProfileError) throw billingProfileError
      if (!billingProfile) throw new Error('Billing profile not found')
      stripeCustomerId = billingProfile.stripe_customer_id

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
        if (!stripeCustomerId && subscriptionIds.some(Boolean)) {
          const discovery = await discoverStripeSubscriptionBilling({
            stripeClient,
            subscriptionIds,
            expectedUserId: user.id,
            includeCustomerSubscriptions: true,
          })
          discovery.observedSubscriptionIds.forEach((id) => observedStripeSubscriptionIds.add(id))
          if (discovery.customerId) {
            const { data: bindAck, error: bindError } = await adminSupabase.rpc(
              'bind_stripe_customer_owner_atomic',
              {
                p_user_id: user.id,
                p_new_stripe_customer_id: discovery.customerId,
                p_expected_previous_stripe_customer_id: null,
              }
            )
            if (bindError || !isExactCustomerBindingAck(bindAck)) {
              throw new Error('Derived Stripe customer ownership could not be bound exactly')
            }
            stripeCustomerId = discovery.customerId
          }
        }

        if (stripeCustomerId) {
          const checkoutResult = await expireOpenSubscriptionCheckouts({
            stripeClient,
            customerId: stripeCustomerId,
            expectedUserId: user.id,
          })
          subscriptionIds.push(...checkoutResult.racedSubscriptionIds)
          checkoutResult.racedSubscriptionIds.forEach((id) => observedStripeSubscriptionIds.add(id))
          mergeOneTimeSettlements(checkoutResult.oneTimeSettlements)

          const stopped = await stopStripeSubscriptionRenewals({
            stripeClient,
            subscriptionIds,
            expectedUserId: user.id,
            expectedCustomerId: stripeCustomerId,
            deletionMode: 'recoverable',
            pauseMarker: user.id,
          })
          if (stopped.customerId !== stripeCustomerId) {
            throw new Error('Stripe subscription enumeration returned the wrong customer')
          }
          stopped.observedSubscriptionIds.forEach((id) => observedStripeSubscriptionIds.add(id))
        }
      }

      await persistAccountDeletionOneTimeSettlementScan({
        supabase: adminSupabase,
        userId: user.id,
        stripeCustomerId,
        observations: [...oneTimeSettlements.values()],
      })
    } catch (error) {
      logger.error('Failed to settle billing surfaces; deletion not scheduled', {
        userId: user.id,
        error: error instanceof Error ? error.message : String(error),
      })
      return NextResponse.json(
        { error: 'Could not stop subscription renewal. Account deletion was not scheduled.' },
        { status: 502 }
      )
    }

    const stripeSubscriptionIds = [...observedStripeSubscriptionIds].sort()
    const scheduleArgs: ScheduleDeletionWithBillingBlocksArgs = {
      p_user_id: user.id,
      p_reason: reason ?? '',
      p_scheduled_at: scheduledDeletion.toISOString(),
      p_recovery_token_hash: recoveryTokenHash,
      p_stripe_customer_id: stripeCustomerId,
      p_stripe_subscription_ids: stripeSubscriptionIds,
    }
    // This RPC is introduced by the same deployment migration; Reflect keeps
    // this route independently type-checkable until generated schema types are
    // refreshed from the deployed database.
    const { data: scheduleAck, error: scheduleError } = (await Reflect.apply(
      adminSupabase.rpc,
      adminSupabase,
      ['schedule_account_deletion_with_billing_blocks', scheduleArgs]
    )) as ScheduleDeletionWithBillingBlocksResult

    if (
      scheduleError ||
      !isExactScheduleDeletionAck(scheduleAck, {
        userId: user.id,
        scheduledAt: scheduledDeletion.toISOString(),
        stripeCustomerId,
        stripeSubscriptionIds,
      })
    ) {
      // Immediate Stripe cancellation is deliberately irreversible: reviving
      // it here could restart Smart Retries while deletion state is uncertain.
      logger.error('Account deletion transaction failed', {
        userId: user.id,
        error: scheduleError?.message ?? 'database returned an invalid deletion acknowledgement',
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
      user_id: user.id,
      deletion_scheduled_at: scheduledDeletion.toISOString(),
      recovery_token: recoveryToken,
      message: 'Account marked for deletion, recoverable within 30 days',
    })
  },
  { name: 'account-delete', rateLimit: 'sensitive' }
)
