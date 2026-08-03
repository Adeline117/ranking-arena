/**
 * Schedule account deletion with a real 30-day recovery window.
 * Related account data is retained until the hard-delete cron runs.
 */

import { createHash, createHmac, randomUUID } from 'node:crypto'
import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { withAuth, withPublic } from '@/lib/api/middleware'
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

const logger = createLogger('account-delete')
const DELETION_COMMIT_COOKIE_PREFIX = 'arena_deletion_'
const RECOVERY_FALLBACK_COOKIE_PREFIX = 'arena_account_recovery_'
// The prepare leg can precede the actual 30-day deletion deadline. Keep the
// provisional browser credentials slightly longer, then pin the recovery
// cookie to PostgreSQL's acknowledged deadline after commit.
const DELETION_CAPABILITY_TTL_SECONDS = 31 * 24 * 60 * 60
const FAIL_CLOSED_AUTH_BAN_DURATION = '876000h'
const FAIL_CLOSED_AUTH_BAN_MINIMUM_MS = 99 * 365 * 24 * 60 * 60 * 1_000

function requireStripeLivemode(): boolean {
  const key = env.STRIPE_SECRET_KEY?.trim()
  if (key?.startsWith('sk_live_')) return true
  if (key?.startsWith('sk_test_')) return false
  throw new Error('STRIPE_SECRET_KEY mode is unavailable')
}

async function verifyDeletionAuthBan(userId: string, minimumBannedUntil: number): Promise<boolean> {
  if (!Number.isFinite(minimumBannedUntil)) {
    logger.error('Deletion Auth ban deadline was invalid', { userId, minimumBannedUntil })
    return false
  }
  const { data, error } = await getSupabaseAdmin().auth.admin.getUserById(userId)
  if (error || !data.user) {
    logger.error('Failed to fresh-read deletion Auth ban state', { userId, error })
    return false
  }
  const bannedUntil = data.user.banned_until ? Date.parse(data.user.banned_until) : Number.NaN
  return Number.isFinite(bannedUntil) && bannedUntil >= minimumBannedUntil
}

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

interface DeletionCapability {
  userId: string
  attemptId: string
  recoveryToken: string
}

function serializeDeletionCapability(value: DeletionCapability): string {
  return Buffer.from(
    JSON.stringify({
      v: 1,
      u: value.userId,
      a: value.attemptId,
      t: value.recoveryToken,
    })
  ).toString('base64url')
}

function deletionCommitCookieName(operationId: string): string {
  return `${DELETION_COMMIT_COOKIE_PREFIX}${operationId}`
}

function recoveryFallbackCookieName(operationId: string): string {
  return `${RECOVERY_FALLBACK_COOKIE_PREFIX}${operationId}`
}

function deriveDeletionRecoveryToken(userId: string, operationId: string): string {
  if (!env.SUPABASE_SERVICE_ROLE_KEY) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required')
  return createHmac('sha256', env.SUPABASE_SERVICE_ROLE_KEY)
    .update(`account-deletion-recovery:v1:${userId}:${operationId}`)
    .digest('base64url')
}

function parseDeletionCapability(value: string | null): DeletionCapability | null {
  if (!value || value.length > 1_024) return null
  try {
    const payload = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >
    if (
      Object.keys(payload).length !== 4 ||
      payload.v !== 1 ||
      typeof payload.u !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        payload.u
      ) ||
      typeof payload.a !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        payload.a
      ) ||
      typeof payload.t !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(payload.t)
    ) {
      return null
    }
    return {
      userId: payload.u,
      attemptId: payload.a,
      recoveryToken: payload.t,
    }
  } catch {
    return null
  }
}

function readCookie(request: Request, name: string): string | null {
  for (const pair of (request.headers.get('cookie') ?? '').split(';')) {
    const separator = pair.indexOf('=')
    if (separator < 0 || pair.slice(0, separator).trim() !== name) continue
    try {
      return decodeURIComponent(pair.slice(separator + 1).trim())
    } catch {
      return null
    }
  }
  return null
}

function isSameOriginBrowserRequest(request: Request): boolean {
  try {
    const configured = env.NEXT_PUBLIC_APP_URL
    if (!configured) return false
    const canonical = new URL(configured)
    return (
      canonical.protocol === 'https:' &&
      request.headers.get('origin') === canonical.origin &&
      request.headers.get('sec-fetch-site') === 'same-origin'
    )
  } catch {
    return false
  }
}

function noStore(response: NextResponse): NextResponse {
  response.headers.set('Cache-Control', 'private, no-store, max-age=0')
  return response
}

function setDeletionCookies(response: NextResponse, capability: DeletionCapability): NextResponse {
  response.cookies.set(
    deletionCommitCookieName(capability.attemptId),
    serializeDeletionCapability(capability),
    {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/api/account/delete',
      maxAge: DELETION_CAPABILITY_TTL_SECONDS,
    }
  )
  // If the final JSON is lost after scheduling, the browser still owns the
  // exact 30-day recovery credential before any destructive commit occurs.
  response.cookies.set(recoveryFallbackCookieName(capability.attemptId), capability.recoveryToken, {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    path: '/api/account/recover',
    maxAge: DELETION_CAPABILITY_TTL_SECONDS,
  })
  return noStore(response)
}

function clearDeletionCommitCookie(response: NextResponse, operationId: string): NextResponse {
  response.cookies.set(deletionCommitCookieName(operationId), '', {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    path: '/api/account/delete',
    maxAge: 0,
  })
  return noStore(response)
}

function clearDeletionCredentials(response: NextResponse, operationId: string): NextResponse {
  clearDeletionCommitCookie(response, operationId)
  return noStore(response)
}

function setRecoveryFallbackExpiry(
  response: NextResponse,
  operationId: string,
  recoveryToken: string,
  deletionScheduledAt: string
): NextResponse {
  response.cookies.set(recoveryFallbackCookieName(operationId), recoveryToken, {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    path: '/api/account/recover',
    expires: new Date(deletionScheduledAt),
  })
  return noStore(response)
}

interface ScheduleDeletionWithBillingBlocksArgs {
  p_user_id: string
  p_operation_id: string
  p_worker_attempt_id: string
  p_fence_token_hash: string
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

function isPersistedScheduleDeletionAck(
  value: unknown,
  userId: string
): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const ack = value as Record<string, unknown>
  const keys = Object.keys(ack).sort()
  if (
    keys.length !== SCHEDULE_DELETION_ACK_KEYS.length ||
    keys.some((key, index) => key !== SCHEDULE_DELETION_ACK_KEYS[index]) ||
    ack.status !== 'scheduled' ||
    ack.user_id !== userId ||
    !isIsoTimestamp(ack.deleted_at) ||
    !isIsoTimestamp(ack.deletion_scheduled_at) ||
    Date.parse(ack.deleted_at) > Date.parse(ack.deletion_scheduled_at) ||
    !Array.isArray(ack.stripe_subscription_ids)
  ) {
    return false
  }
  const ids = ack.stripe_subscription_ids
  return (
    ids.every((id) => typeof id === 'string') &&
    ids.every((id, index) => id === [...new Set(ids)].sort()[index]) &&
    (ack.stripe_customer_id === null || typeof ack.stripe_customer_id === 'string')
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

interface DeletionSubject {
  id: string
  email?: string
  identities?: Array<{ provider: string }>
}

async function handleDeletion(
  user: DeletionSubject,
  request: Request,
  capability: DeletionCapability | null
): Promise<NextResponse> {
  let body: { password?: string; reason?: string; confirm?: string; operation_id?: string }
  try {
    body = await request.json()
  } catch {
    return badRequest('Invalid JSON body')
  }
  const reason = typeof body.reason === 'string' ? body.reason.trim() : ''

  const adminSupabase = getSupabaseAdmin()
  let deletionFenceAttemptId: string
  let recoveryToken: string
  let recoveryTokenHash: string
  const deletionWorkerAttemptId = randomUUID()

  if (!capability) {
    const { password, confirm } = body
    if (
      body.reason !== undefined &&
      (typeof body.reason !== 'string' || Buffer.byteLength(reason, 'utf8') > 256)
    ) {
      return badRequest('Deletion reason is invalid')
    }
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
    if (
      typeof body.operation_id !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        body.operation_id
      )
    ) {
      return badRequest('A valid deletion operation_id is required')
    }
    deletionFenceAttemptId = body.operation_id
    recoveryToken = deriveDeletionRecoveryToken(user.id, deletionFenceAttemptId)
    recoveryTokenHash = createHash('sha256').update(recoveryToken).digest('hex')
    const { data: prepareAck, error: prepareError } = (await Reflect.apply(
      adminSupabase.rpc,
      adminSupabase,
      [
        'prepare_account_deletion_auth_fence_atomic',
        {
          p_user_id: user.id,
          p_operation_id: deletionFenceAttemptId,
          p_recovery_token_hash: recoveryTokenHash,
          p_reason: reason,
        },
      ]
    )) as { data: unknown; error: { message: string } | null }
    if (prepareError || (prepareAck !== 'prepared' && prepareAck !== 'busy')) {
      return NextResponse.json(
        { error: 'Account deletion is temporarily unavailable. Please try again.' },
        { status: 503 }
      )
    }
    if (prepareAck === 'busy') {
      return NextResponse.json(
        { error: 'Account recovery finalization is in progress. Please try again.' },
        { status: 409 }
      )
    }
    return setDeletionCookies(
      NextResponse.json(
        {
          status: 'prepared',
          operation_id: deletionFenceAttemptId,
          recovery_token: recoveryToken,
        },
        { status: 202 }
      ),
      {
        userId: user.id,
        attemptId: deletionFenceAttemptId,
        recoveryToken,
      }
    )
  }

  deletionFenceAttemptId = capability.attemptId
  recoveryToken = capability.recoveryToken
  recoveryTokenHash = createHash('sha256').update(recoveryToken).digest('hex')
  const { data: deletionFenceAck, error: deletionFenceError } = (await Reflect.apply(
    adminSupabase.rpc,
    adminSupabase,
    [
      'claim_account_deletion_auth_fence_atomic',
      {
        p_user_id: user.id,
        p_operation_id: deletionFenceAttemptId,
        p_worker_attempt_id: deletionWorkerAttemptId,
        p_recovery_token_hash: recoveryTokenHash,
      },
    ]
  )) as { data: unknown; error: { message: string } | null }
  if (deletionFenceError) {
    logger.error('Failed to fence account deletion against Auth recovery finalization', {
      userId: user.id,
      error: deletionFenceError?.message ?? 'invalid deletion fence acknowledgement',
    })
    return setDeletionCookies(
      NextResponse.json(
        { code: 'operation_unavailable', error: 'Account deletion is temporarily unavailable.' },
        { status: 503 }
      ),
      capability
    )
  }
  if (
    !['billing_pending', 'busy', 'auth_ban_pending', 'completed'].includes(String(deletionFenceAck))
  ) {
    return clearDeletionCredentials(
      NextResponse.json(
        { code: 'capability_invalid', error: 'Deletion authorization expired.' },
        { status: 410 }
      ),
      deletionFenceAttemptId
    )
  }
  if (deletionFenceAck === 'busy') {
    const response = setDeletionCookies(
      NextResponse.json(
        { code: 'operation_busy', error: 'Account recovery finalization is in progress.' },
        { status: 503 }
      ),
      capability
    )
    response.headers.set('Retry-After', '5')
    return response
  }
  const now = new Date()
  const scheduledDeletion = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1_000)
  const isScheduleResume =
    deletionFenceAck === 'auth_ban_pending' || deletionFenceAck === 'completed'

  // Stop every recurring billing surface before writing the deletion
  // tombstone. API-tier billing is stored on user_profiles, independently of
  // the consumer Pro row in subscriptions. Open subscription Checkout
  // Sessions must also be expired or they can create a first charge later.
  let recurringSubscriptionId: string | null = null
  let stripeCustomerId: string | null = null
  const observedStripeSubscriptionIds = new Set<string>()
  let scheduleAck: unknown = null
  let acknowledgedScheduledAt = scheduledDeletion.toISOString()
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
  if (!isScheduleResume) {
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
            livemode: requireStripeLivemode(),
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
            livemode: requireStripeLivemode(),
          })
          subscriptionIds.push(...checkoutResult.racedSubscriptionIds)
          checkoutResult.racedSubscriptionIds.forEach((id) => observedStripeSubscriptionIds.add(id))
          mergeOneTimeSettlements(checkoutResult.oneTimeSettlements)

          const stopped = await stopStripeSubscriptionRenewals({
            stripeClient,
            subscriptionIds,
            expectedCustomerId: stripeCustomerId,
            expectedUserId: user.id,
            livemode: requireStripeLivemode(),
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
      return setDeletionCookies(
        NextResponse.json(
          { error: 'Account deletion billing finalization is temporarily unavailable.' },
          { status: 503 }
        ),
        capability
      )
    }

    const stripeSubscriptionIds = [...observedStripeSubscriptionIds].sort()
    const scheduleArgs: ScheduleDeletionWithBillingBlocksArgs = {
      p_user_id: user.id,
      p_operation_id: deletionFenceAttemptId,
      p_worker_attempt_id: deletionWorkerAttemptId,
      p_fence_token_hash: recoveryTokenHash,
      p_scheduled_at: scheduledDeletion.toISOString(),
      p_recovery_token_hash: recoveryTokenHash,
      p_stripe_customer_id: stripeCustomerId,
      p_stripe_subscription_ids: stripeSubscriptionIds,
    }
    // This RPC is introduced by the same deployment migration; Reflect keeps
    // this route independently type-checkable until generated schema types are
    // refreshed from the deployed database.
    const { data: newScheduleAck, error: scheduleError } = (await Reflect.apply(
      adminSupabase.rpc,
      adminSupabase,
      ['schedule_account_deletion_with_billing_blocks_fenced', scheduleArgs]
    )) as ScheduleDeletionWithBillingBlocksResult
    scheduleAck = newScheduleAck

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
      return setDeletionCookies(
        NextResponse.json(
          { error: 'Account deletion finalization is temporarily unavailable.' },
          { status: 503 }
        ),
        capability
      )
    }
  } else {
    const resumeArgs: ScheduleDeletionWithBillingBlocksArgs = {
      p_user_id: user.id,
      p_operation_id: deletionFenceAttemptId,
      p_worker_attempt_id: deletionWorkerAttemptId,
      p_fence_token_hash: recoveryTokenHash,
      p_scheduled_at: scheduledDeletion.toISOString(),
      p_recovery_token_hash: recoveryTokenHash,
      p_stripe_customer_id: null,
      p_stripe_subscription_ids: [],
    }
    const { data, error } = (await Reflect.apply(adminSupabase.rpc, adminSupabase, [
      'schedule_account_deletion_with_billing_blocks_fenced',
      resumeArgs,
    ])) as ScheduleDeletionWithBillingBlocksResult
    if (error || !isPersistedScheduleDeletionAck(data, user.id)) {
      return setDeletionCookies(
        NextResponse.json(
          { error: 'Account deletion finalization is temporarily unavailable.' },
          { status: 503 }
        ),
        capability
      )
    }
    scheduleAck = data
    acknowledgedScheduledAt = data.deletion_scheduled_at as string
  }

  if (deletionFenceAck !== 'completed') {
    const minimumBannedUntil = Math.max(
      Date.parse(acknowledgedScheduledAt),
      Date.now() + FAIL_CLOSED_AUTH_BAN_MINIMUM_MS
    )
    const { error: banError } = await adminSupabase.auth.admin.updateUserById(user.id, {
      ban_duration: FAIL_CLOSED_AUTH_BAN_DURATION,
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
      return setDeletionCookies(
        NextResponse.json(
          { error: 'Account deletion finalization is temporarily unavailable.' },
          { status: 503 }
        ),
        capability
      )
    }
    if (!(await verifyDeletionAuthBan(user.id, minimumBannedUntil))) {
      return setDeletionCookies(
        NextResponse.json(
          { error: 'Account deletion finalization is temporarily unavailable.' },
          { status: 503 }
        ),
        capability
      )
    }

    const { data: completedFenceAck, error: completedFenceError } = (await Reflect.apply(
      adminSupabase.rpc,
      adminSupabase,
      [
        'complete_account_deletion_auth_fence_atomic',
        {
          p_user_id: user.id,
          p_operation_id: deletionFenceAttemptId,
          p_worker_attempt_id: deletionWorkerAttemptId,
          p_recovery_token_hash: recoveryTokenHash,
        },
      ]
    )) as { data: unknown; error: { message: string } | null }
    if (completedFenceError || completedFenceAck !== 'completed') {
      logger.error('Account deletion Auth fence completion was ambiguous', {
        userId: user.id,
        error: completedFenceError?.message ?? 'invalid deletion fence completion acknowledgement',
      })
      return setDeletionCookies(
        NextResponse.json(
          { error: 'Account deletion finalization is temporarily unavailable.' },
          { status: 503 }
        ),
        capability
      )
    }
  }

  logger.info('Account deletion scheduled', { userId: user.id })
  return setRecoveryFallbackExpiry(
    clearDeletionCommitCookie(
      NextResponse.json({
        success: true,
        deletion_scheduled_at: acknowledgedScheduledAt,
        recovery_token: recoveryToken,
        message: 'Account marked for deletion, recoverable within 30 days',
      }),
      deletionFenceAttemptId
    ),
    deletionFenceAttemptId,
    recoveryToken,
    acknowledgedScheduledAt
  )
}

const authenticatedDeletionPost = withAuth(
  async ({ user, request }) => handleDeletion(user, request, null),
  { name: 'account-delete-prepare', rateLimit: 'sensitive' }
)

const capabilityDeletionHandler = async ({ request }: { request: Request }) => {
  if (new URL(request.url).searchParams.get('phase') === 'status') {
    if (!isSameOriginBrowserRequest(request)) {
      return noStore(NextResponse.json({ operations: [] }, { status: 401 }))
    }
    const rawCookie = request.headers.get('cookie') ?? ''
    if (rawCookie.length > 16_384) {
      return noStore(NextResponse.json({ operations: [] }, { status: 431 }))
    }
    const operations: Array<{ operation_id: string; state: string }> = []
    const admin = getSupabaseAdmin()
    for (const pair of rawCookie.split(';')) {
      const separator = pair.indexOf('=')
      const name = separator < 0 ? '' : pair.slice(0, separator).trim()
      if (!name.startsWith(DELETION_COMMIT_COOKIE_PREFIX) || operations.length >= 10) continue
      const operationId = name.slice(DELETION_COMMIT_COOKIE_PREFIX.length)
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          operationId
        )
      )
        continue
      let decoded: string
      try {
        decoded = decodeURIComponent(pair.slice(separator + 1).trim())
      } catch {
        continue
      }
      const candidate = parseDeletionCapability(decoded)
      if (candidate?.attemptId !== operationId) continue
      const tokenHash = createHash('sha256').update(candidate.recoveryToken).digest('hex')
      const { data, error } = (await Reflect.apply(admin.rpc, admin, [
        'resolve_account_deletion_capability_atomic',
        {
          p_user_id: candidate.userId,
          p_operation_id: candidate.attemptId,
          p_recovery_token_hash: tokenHash,
        },
      ])) as { data: unknown; error: { message: string } | null }
      if (error) {
        logger.error('Deletion capability discovery authority was unavailable', {
          operationId,
          error: error.message,
        })
        return noStore(
          NextResponse.json({ operations: [], error: 'Status unavailable' }, { status: 503 })
        )
      }
      if (typeof data === 'string' && data !== 'invalid') {
        operations.push({ operation_id: operationId, state: data })
      }
    }
    return noStore(NextResponse.json({ operations }))
  }
  let body: { operation_id?: string }
  try {
    body = await request.clone().json()
  } catch {
    return badRequest('Invalid JSON body')
  }
  const operationId = body.operation_id
  if (
    typeof operationId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      operationId
    ) ||
    !isSameOriginBrowserRequest(request)
  ) {
    return noStore(NextResponse.json({ error: 'Invalid deletion capability' }, { status: 409 }))
  }
  const capability = parseDeletionCapability(
    readCookie(request, deletionCommitCookieName(operationId))
  )
  if (!capability || capability.attemptId !== operationId) {
    return noStore(NextResponse.json({ error: 'Invalid deletion capability' }, { status: 409 }))
  }
  return handleDeletion({ id: capability.userId }, request, capability)
}

const capabilityDeletionPost = withPublic(capabilityDeletionHandler, {
  name: 'account-delete-commit',
  rateLimit: 'sensitive',
  skipCsrf: true,
})
const deletionStatusPost = withPublic(capabilityDeletionHandler, {
  name: 'account-delete-status',
  rateLimit: {
    requests: 60,
    window: 60,
    prefix: 'account-delete-status',
    failClose: true,
  },
  skipCsrf: true,
})

export async function POST(request: Request): Promise<Response> {
  const phase = new URL(request.url).searchParams.get('phase')
  if (phase !== null && phase !== 'commit' && phase !== 'status') {
    return noStore(NextResponse.json({ error: 'Invalid deletion phase' }, { status: 400 }))
  }
  const response = await (phase === 'status'
    ? deletionStatusPost(request as never)
    : phase === 'commit'
      ? capabilityDeletionPost(request as never)
      : authenticatedDeletionPost(request as never))
  response.headers.set('Cache-Control', 'private, no-store, max-age=0')
  return response
}
