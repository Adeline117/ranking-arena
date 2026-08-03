import type { UserSubscription } from './index'
import { authedFetch } from '@/lib/api/client'

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
  expectedSessionGeneration: number
): Promise<UserSubscription> {
  if (
    !accessToken ||
    !expectedUserId ||
    !Number.isSafeInteger(expectedSessionGeneration) ||
    expectedSessionGeneration < 0
  ) {
    throw new Error('Subscription request identity is missing')
  }

  const response = await authedFetch<unknown>(
    '/api/subscription',
    'GET',
    accessToken,
    undefined,
    10_000,
    {
      expectedUserId,
      expectedSessionGeneration,
    }
  )
  if (response.stale) {
    throw new Error('Subscription request identity changed')
  }
  if (!response.ok) {
    throw new Error(
      response.status > 0
        ? `Subscription API returned HTTP ${response.status}`
        : 'Subscription API is unavailable'
    )
  }
  if (response.data === null) {
    throw new Error('Subscription API returned malformed JSON')
  }

  return parseSubscriptionResponse(response.data, expectedUserId)
}
