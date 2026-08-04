import type { UserSubscription } from './index'

export const SUBSCRIPTION_REQUEST_TIMEOUT_MS = 10_000

export class SubscriptionRequestError extends Error {
  readonly status: number | null

  constructor(message: string, status: number | null = null, options?: ErrorOptions) {
    super(message, options)
    this.name = 'SubscriptionRequestError'
    this.status = status
  }
}

const SUBSCRIPTION_KEYS = [
  'userId',
  'tier',
  'status',
  'startDate',
  'endDate',
  'trialEndDate',
  'autoRenew',
  'paymentMethod',
  'usage',
  'plan',
  'currentPeriodEnd',
  'cancelAtPeriodEnd',
] as const

const USAGE_KEYS = [
  'apiCallsToday',
  'comparisonReportsThisMonth',
  'exportsThisMonth',
  'currentFollows',
  'currentCustomRankings',
] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key))
}

function hasKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
}

function isDateOrNull(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && Number.isFinite(Date.parse(value)))
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isFeatureUsage(value: unknown): value is UserSubscription['usage'] {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, USAGE_KEYS) &&
    hasKeys(value, USAGE_KEYS) &&
    USAGE_KEYS.every((key) => isCount(value[key]))
  )
}

function isPaymentMethod(value: unknown): value is NonNullable<UserSubscription['paymentMethod']> {
  return value === 'stripe' || value === 'paypal' || value === 'crypto'
}

export function parseSubscriptionResponse(
  value: unknown,
  expectedUserId: string
): UserSubscription {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['subscription']) ||
    !hasKeys(value, ['subscription'])
  ) {
    throw new Error('Subscription API returned an invalid response envelope')
  }
  if (!isRecord(value.subscription)) {
    throw new Error('Subscription API returned an invalid subscription')
  }

  const subscription = value.subscription
  const requiredKeys = SUBSCRIPTION_KEYS.filter(
    (key) => !['paymentMethod', 'plan', 'currentPeriodEnd', 'cancelAtPeriodEnd'].includes(key)
  )
  if (
    !hasOnlyKeys(subscription, SUBSCRIPTION_KEYS) ||
    !hasKeys(subscription, requiredKeys) ||
    subscription.userId !== expectedUserId ||
    (subscription.tier !== 'free' && subscription.tier !== 'pro') ||
    (subscription.status !== 'active' && subscription.status !== 'trialing') ||
    typeof subscription.startDate !== 'string' ||
    !Number.isFinite(Date.parse(subscription.startDate)) ||
    !isDateOrNull(subscription.endDate) ||
    !isDateOrNull(subscription.trialEndDate) ||
    typeof subscription.autoRenew !== 'boolean' ||
    (subscription.paymentMethod !== undefined && !isPaymentMethod(subscription.paymentMethod)) ||
    (subscription.plan !== undefined &&
      (typeof subscription.plan !== 'string' || subscription.plan.trim().length === 0)) ||
    (subscription.currentPeriodEnd !== undefined && !isDateOrNull(subscription.currentPeriodEnd)) ||
    (subscription.cancelAtPeriodEnd !== undefined &&
      typeof subscription.cancelAtPeriodEnd !== 'boolean') ||
    !isFeatureUsage(subscription.usage)
  ) {
    throw new Error('Subscription API returned an inconsistent subscription')
  }

  const verifiedSubscription: UserSubscription = {
    userId: subscription.userId,
    tier: subscription.tier,
    status: subscription.status,
    startDate: subscription.startDate,
    endDate: subscription.endDate,
    trialEndDate: subscription.trialEndDate,
    autoRenew: subscription.autoRenew,
    usage: subscription.usage,
  }
  if (subscription.paymentMethod !== undefined) {
    verifiedSubscription.paymentMethod = subscription.paymentMethod
  }
  return verifiedSubscription
}

export async function fetchVerifiedSubscription(
  accessToken: string,
  expectedUserId: string,
  fetchImpl: typeof fetch = fetch,
  callerSignal?: AbortSignal
): Promise<UserSubscription> {
  if (!accessToken || !expectedUserId) {
    throw new Error('Subscription request identity is missing')
  }

  if (callerSignal?.aborted) throw new SubscriptionRequestError('Subscription request cancelled')
  const controller = new AbortController()
  let rejectInterruption: ((reason: Error) => void) | undefined
  const interruption = new Promise<never>((_resolve, reject) => {
    rejectInterruption = reject
  })
  const interrupt = (reason: Error) => {
    if (!controller.signal.aborted) controller.abort(reason)
    rejectInterruption?.(reason)
  }
  const onCallerAbort = () =>
    interrupt(new SubscriptionRequestError('Subscription request cancelled'))
  callerSignal?.addEventListener('abort', onCallerAbort, { once: true })
  const timeout = setTimeout(
    () => interrupt(new SubscriptionRequestError('Subscription request timed out')),
    SUBSCRIPTION_REQUEST_TIMEOUT_MS
  )

  try {
    const response = await Promise.race([
      fetchImpl('/api/subscription', {
        method: 'GET',
        credentials: 'include',
        cache: 'no-store',
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: controller.signal,
      }),
      interruption,
    ])
    if (!response.ok || response.status !== 200) {
      throw new SubscriptionRequestError(
        `Subscription API returned HTTP ${response.status}`,
        response.status
      )
    }

    let payload: unknown
    try {
      payload = await Promise.race([response.json(), interruption])
    } catch (cause) {
      if (cause instanceof SubscriptionRequestError) throw cause
      throw new SubscriptionRequestError(
        'Subscription API returned malformed JSON',
        response.status,
        {
          cause,
        }
      )
    }
    return parseSubscriptionResponse(payload, expectedUserId)
  } finally {
    clearTimeout(timeout)
    callerSignal?.removeEventListener('abort', onCallerAbort)
  }
}
