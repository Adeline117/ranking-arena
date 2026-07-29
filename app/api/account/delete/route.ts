/**
 * Schedule account deletion with a real 30-day recovery window.
 * Related account data is retained until the hard-delete cron runs.
 */

import { createHash, randomUUID } from 'node:crypto'
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
import { enforceAccountDeletionAuthBan } from '@/lib/account/deletion-auth-invalidation'

const logger = createLogger('account-delete')

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface PrepareDeletionBillingArgs {
  p_user_id: string
  p_operation_id: string
  p_reason: string
  p_scheduled_at: string
  p_recovery_token_hash: string
  p_stripe_customer_id: string | null
  p_stripe_subscription_ids: string[]
}

interface DeletionBillingRpcResult {
  data: unknown
  error: { message: string } | null
}

const PREPARE_DELETION_ACK_KEYS = [
  'status',
  'operation_id',
  'user_id',
  'deleted_at',
  'deletion_scheduled_at',
  'stripe_customer_id',
  'stripe_subscription_ids',
].sort()
const FINISH_DELETION_ACK_KEYS = [
  'status',
  'operation_id',
  'user_id',
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

function isExactStringSet(value: unknown, expected: string[]): boolean {
  if (!Array.isArray(value) || value.some((id) => typeof id !== 'string')) return false
  const receivedIds = value as string[]
  const normalizedIds = [...new Set(receivedIds)].sort()
  return (
    receivedIds.length === normalizedIds.length &&
    receivedIds.every((id, index) => id === normalizedIds[index]) &&
    receivedIds.length === expected.length &&
    receivedIds.every((id, index) => id === expected[index])
  )
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const keys = Object.keys(value).sort()
  return keys.length === expected.length && keys.every((key, index) => key === expected[index])
}

function isExactPrepareDeletionAck(
  value: unknown,
  expected: {
    operationId: string
    userId: string
    scheduledAt: string
    stripeCustomerId: string | null
    stripeSubscriptionIds: string[]
  }
): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const ack = value as Record<string, unknown>
  if (!hasExactKeys(ack, PREPARE_DELETION_ACK_KEYS)) return false

  if (
    ack.status !== 'prepared' ||
    ack.operation_id !== expected.operationId ||
    ack.user_id !== expected.userId ||
    ack.deletion_scheduled_at !== expected.scheduledAt ||
    ack.stripe_customer_id !== expected.stripeCustomerId ||
    !isIsoTimestamp(ack.deleted_at) ||
    Date.parse(ack.deleted_at) > Date.parse(expected.scheduledAt)
  ) {
    return false
  }

  return isExactStringSet(ack.stripe_subscription_ids, expected.stripeSubscriptionIds)
}

function isExactFinishDeletionAck(
  value: unknown,
  expected: {
    operationId: string
    userId: string
    stripeCustomerId: string | null
    stripeSubscriptionIds: string[]
  }
): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const ack = value as Record<string, unknown>
  return (
    hasExactKeys(ack, FINISH_DELETION_ACK_KEYS) &&
    ack.status === 'settled' &&
    ack.operation_id === expected.operationId &&
    ack.user_id === expected.userId &&
    ack.stripe_customer_id === expected.stripeCustomerId &&
    isExactStringSet(ack.stripe_subscription_ids, expected.stripeSubscriptionIds)
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
    const bearerMatch = request.headers.get('authorization')?.match(/^Bearer\s+(\S+)$/i)
    if (!bearerMatch) {
      return forbidden('Unable to verify account session')
    }
    const currentAccessToken = bearerMatch[1]
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

    const operationId = randomUUID()

    // Resolve and attest every currently visible billing identity without
    // mutating Stripe. The database then persists the deletion tombstone and
    // retry operation before the first irreversible remote write.
    let recurringSubscriptionId: string | null = null
    let stripeCustomerId: string | null = null
    const observedStripeSubscriptionIds = new Set<string>()
    let stripeClient: ReturnType<typeof getStripe> | null = null
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
        stripeClient = getStripe()
        const discovery = await discoverStripeSubscriptionBilling({
          stripeClient,
          subscriptionIds,
          expectedUserId: user.id,
          expectedCustomerId: stripeCustomerId,
          includeCustomerSubscriptions: true,
        })
        discovery.observedSubscriptionIds.forEach((id) => observedStripeSubscriptionIds.add(id))
        if (stripeCustomerId && discovery.customerId !== stripeCustomerId) {
          throw new Error('Stripe subscription discovery returned the wrong customer')
        }
        if (!stripeCustomerId) {
          if (!discovery.customerId) {
            throw new Error('Stripe customer identity could not be proven for account deletion')
          }
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
    } catch (error) {
      logger.error('Failed to attest billing surfaces; deletion not scheduled', {
        userId: user.id,
        error: error instanceof Error ? error.message : String(error),
      })
      return NextResponse.json(
        { error: 'Could not verify subscription ownership. Account deletion was not scheduled.' },
        { status: 502 }
      )
    }

    const preparedStripeSubscriptionIds = [...observedStripeSubscriptionIds].sort()
    const prepareArgs: PrepareDeletionBillingArgs = {
      p_user_id: user.id,
      p_operation_id: operationId,
      p_reason: reason ?? '',
      p_scheduled_at: scheduledDeletion.toISOString(),
      p_recovery_token_hash: recoveryTokenHash,
      p_stripe_customer_id: stripeCustomerId,
      p_stripe_subscription_ids: preparedStripeSubscriptionIds,
    }
    const { data: prepareAck, error: prepareError } = (await Reflect.apply(
      adminSupabase.rpc,
      adminSupabase,
      ['prepare_account_deletion_billing_atomic', prepareArgs]
    )) as DeletionBillingRpcResult

    if (
      prepareError ||
      !isExactPrepareDeletionAck(prepareAck, {
        operationId,
        userId: user.id,
        scheduledAt: scheduledDeletion.toISOString(),
        stripeCustomerId,
        stripeSubscriptionIds: preparedStripeSubscriptionIds,
      })
    ) {
      logger.error('Account deletion preparation failed before Stripe mutation', {
        userId: user.id,
        operationId,
        error: prepareError?.message ?? 'database returned an invalid preparation acknowledgement',
      })
      return NextResponse.json(
        { error: 'Failed to schedule account deletion. Please try again.' },
        { status: 503 }
      )
    }

    // The tombstone is now durable. Auth invalidation and every Stripe write
    // may fail independently without making the account active again.
    let authBanReady = false
    let authBanError: unknown = null
    try {
      await enforceAccountDeletionAuthBan(adminSupabase.auth.admin, user.id)
      authBanReady = true
    } catch (error) {
      authBanError = error
    }
    let signOutError: unknown = null
    try {
      const result = await adminSupabase.auth.admin.signOut(currentAccessToken, 'global')
      signOutError = result.error
    } catch (error) {
      signOutError = error
    }
    if (!authBanReady || signOutError) {
      // `deleted_at` is independently enforced by server auth, so access stays
      // blocked even if Supabase session invalidation is temporarily degraded.
      logger.error('Account scheduled but auth invalidation was incomplete', {
        userId: user.id,
        banError:
          authBanError instanceof Error
            ? authBanError.message
            : authBanError
              ? String(authBanError)
              : undefined,
        signOutError:
          signOutError instanceof Error
            ? signOutError.message
            : signOutError
              ? String(signOutError)
              : undefined,
      })
    }

    const scheduledResponse = (
      billingSettlementPending: boolean,
      authInvalidationPending: boolean
    ) =>
      NextResponse.json(
        {
          success: true,
          user_id: user.id,
          deletion_scheduled_at: scheduledDeletion.toISOString(),
          recovery_token: recoveryToken,
          billing_settlement_pending: billingSettlementPending,
          auth_invalidation_pending: authInvalidationPending,
          message:
            billingSettlementPending || authInvalidationPending
              ? 'Account marked for deletion. Secure shutdown is still being retried.'
              : 'Account marked for deletion, recoverable within 30 days',
        },
        { status: billingSettlementPending || authInvalidationPending ? 202 : 200 }
      )

    try {
      if (stripeCustomerId && stripeClient) {
        const checkoutResult = await expireOpenSubscriptionCheckouts({
          stripeClient,
          customerId: stripeCustomerId,
          expectedUserId: user.id,
        })
        checkoutResult.racedSubscriptionIds.forEach((id) => observedStripeSubscriptionIds.add(id))
        mergeOneTimeSettlements(checkoutResult.oneTimeSettlements)

        const stopped = await stopStripeSubscriptionRenewals({
          stripeClient,
          subscriptionIds: [...observedStripeSubscriptionIds].sort(),
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

      await persistAccountDeletionOneTimeSettlementScan({
        supabase: adminSupabase,
        userId: user.id,
        stripeCustomerId,
        observations: [...oneTimeSettlements.values()],
      })
    } catch (error) {
      logger.error('Account deletion billing settlement will be retried from durable intent', {
        userId: user.id,
        operationId,
        error: error instanceof Error ? error.message : String(error),
      })
      return scheduledResponse(true, !authBanReady || !!signOutError)
    }

    // Keep the durable operation prepared until the authoritative Auth ban is
    // confirmed. The reconciliation worker will repeat both this ban and the
    // idempotent Stripe settlement before it can seal the operation.
    if (!authBanReady) return scheduledResponse(true, true)

    const settledStripeSubscriptionIds = [...observedStripeSubscriptionIds].sort()
    const { data: finishAck, error: finishError } = (await Reflect.apply(
      adminSupabase.rpc,
      adminSupabase,
      [
        'finish_account_deletion_billing_atomic',
        {
          p_user_id: user.id,
          p_operation_id: operationId,
          p_stripe_customer_id: stripeCustomerId,
          p_stripe_subscription_ids: settledStripeSubscriptionIds,
        },
      ]
    )) as DeletionBillingRpcResult

    if (
      finishError ||
      !isExactFinishDeletionAck(finishAck, {
        operationId,
        userId: user.id,
        stripeCustomerId,
        stripeSubscriptionIds: settledStripeSubscriptionIds,
      })
    ) {
      logger.error('Account deletion billing finish will be retried from durable intent', {
        userId: user.id,
        operationId,
        error: finishError?.message ?? 'database returned an invalid finish acknowledgement',
      })
      return scheduledResponse(true, !!signOutError)
    }

    logger.info('Account deletion scheduled and billing settled', { userId: user.id, operationId })
    return scheduledResponse(false, !!signOutError)
  },
  { name: 'account-delete', rateLimit: 'sensitive' }
)
