import { BASE_URL } from '@/lib/constants/urls'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const REFERRAL_CODE_PATTERN = /^[A-Za-z0-9_-]{2,64}$/
const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/

type JsonRecord = Record<string, unknown>

export type ReferralRewardStatus =
  | 'not_granted'
  | 'pending'
  | 'scheduled'
  | 'active'
  | 'expired'
  | 'revoked'

export type ReferralRewardSnapshot = Readonly<{
  rewardId: string | null
  status: ReferralRewardStatus
  grantedDays: number | null
  entitlementGrantedAt: string | null
  entitlementStartsAt: string | null
  entitlementExpiresAt: string | null
  entitlementRevokedAt: string | null
}>

export type ReferralSnapshot = Readonly<{
  ownerId: string
  referralCode: string | null
  referralLink: string | null
  codeSource: 'none' | 'handle' | 'custom'
  qualifiedReferralCount: number
  advocateReward: ReferralRewardSnapshot
}>

export type ReferralCodeCreation = Readonly<{
  ownerId: string
  referralCode: string
  referralLink: string
  codeSource: 'custom'
}>

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(record: JsonRecord, expected: readonly string[]): boolean {
  const actual = Object.keys(record).sort()
  const canonical = [...expected].sort()
  return (
    actual.length === canonical.length && actual.every((key, index) => key === canonical[index])
  )
}

function isCanonicalUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value)
}

function isIsoTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 64 &&
    ISO_TIMESTAMP_PATTERN.test(value) &&
    Number.isFinite(Date.parse(value))
  )
}

function isNullableTimestamp(value: unknown): value is string | null {
  return value === null || isIsoTimestamp(value)
}

function expectedReferralLink(code: string): string {
  return `${BASE_URL}/?ref=${encodeURIComponent(code)}`
}

function readEnvelope(value: unknown): JsonRecord | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['data', 'meta', 'success']) ||
    value.success !== true ||
    !isRecord(value.data) ||
    !isRecord(value.meta) ||
    !hasExactKeys(value.meta, ['timestamp']) ||
    !isIsoTimestamp(value.meta.timestamp)
  ) {
    return null
  }
  return value.data
}

function readReward(value: unknown): ReferralRewardSnapshot | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'entitlement_expires_at',
      'entitlement_granted_at',
      'entitlement_revoked_at',
      'entitlement_starts_at',
      'granted_days',
      'reward_id',
      'status',
    ]) ||
    !['not_granted', 'pending', 'scheduled', 'active', 'expired', 'revoked'].includes(
      String(value.status)
    ) ||
    !isNullableTimestamp(value.entitlement_granted_at) ||
    !isNullableTimestamp(value.entitlement_starts_at) ||
    !isNullableTimestamp(value.entitlement_expires_at) ||
    !isNullableTimestamp(value.entitlement_revoked_at)
  ) {
    return null
  }

  if (value.status === 'not_granted') {
    if (
      value.reward_id !== null ||
      value.granted_days !== null ||
      value.entitlement_granted_at !== null ||
      value.entitlement_starts_at !== null ||
      value.entitlement_expires_at !== null ||
      value.entitlement_revoked_at !== null
    ) {
      return null
    }
  } else {
    if (
      !isCanonicalUuid(value.reward_id) ||
      !Number.isSafeInteger(value.granted_days) ||
      Number(value.granted_days) < 1 ||
      Number(value.granted_days) > 3650
    ) {
      return null
    }
    if (
      value.status === 'pending' &&
      (value.entitlement_granted_at !== null ||
        value.entitlement_starts_at !== null ||
        value.entitlement_expires_at !== null ||
        value.entitlement_revoked_at !== null)
    ) {
      return null
    }
    if (
      ['scheduled', 'active', 'expired', 'revoked'].includes(String(value.status)) &&
      (value.entitlement_granted_at === null ||
        value.entitlement_starts_at === null ||
        value.entitlement_expires_at === null)
    ) {
      return null
    }
    if (
      (value.status === 'scheduled' || value.status === 'active' || value.status === 'expired') &&
      value.entitlement_revoked_at !== null
    ) {
      return null
    }
    if (value.status === 'revoked' && value.entitlement_revoked_at === null) return null

    if (value.status !== 'pending') {
      const startsAt = Date.parse(value.entitlement_starts_at as string)
      const expiresAt = Date.parse(value.entitlement_expires_at as string)
      const now = Date.now()
      if (startsAt >= expiresAt) return null
      if (value.status === 'scheduled' && startsAt <= now) return null
      if (value.status === 'active' && (startsAt > now || expiresAt <= now)) return null
      if (value.status === 'expired' && expiresAt > now) return null
    }
  }

  return {
    rewardId: value.reward_id as string | null,
    status: value.status as ReferralRewardStatus,
    grantedDays: value.granted_days as number | null,
    entitlementGrantedAt: value.entitlement_granted_at,
    entitlementStartsAt: value.entitlement_starts_at,
    entitlementExpiresAt: value.entitlement_expires_at,
    entitlementRevokedAt: value.entitlement_revoked_at,
  }
}

export function readReferralSnapshot(
  value: unknown,
  expected: { ownerId: string }
): ReferralSnapshot | null {
  const data = readEnvelope(value)
  if (!data || !hasExactKeys(data, ['referral']) || !isRecord(data.referral)) return null

  const referral = data.referral
  if (
    !hasExactKeys(referral, [
      'advocate_reward',
      'code_source',
      'owner_id',
      'qualified_referral_count',
      'referral_code',
      'referral_link',
    ]) ||
    !isCanonicalUuid(expected.ownerId) ||
    referral.owner_id !== expected.ownerId ||
    !Number.isSafeInteger(referral.qualified_referral_count) ||
    Number(referral.qualified_referral_count) < 0
  ) {
    return null
  }

  const reward = readReward(referral.advocate_reward)
  if (!reward) return null

  if (referral.code_source === 'none') {
    if (referral.referral_code !== null || referral.referral_link !== null) return null
  } else if (referral.code_source === 'handle' || referral.code_source === 'custom') {
    if (
      typeof referral.referral_code !== 'string' ||
      !REFERRAL_CODE_PATTERN.test(referral.referral_code) ||
      referral.referral_link !== expectedReferralLink(referral.referral_code)
    ) {
      return null
    }
  } else {
    return null
  }

  return {
    ownerId: referral.owner_id,
    referralCode: referral.referral_code as string | null,
    referralLink: referral.referral_link as string | null,
    codeSource: referral.code_source,
    qualifiedReferralCount: Number(referral.qualified_referral_count),
    advocateReward: reward,
  }
}

export function readReferralCodeCreation(
  value: unknown,
  expected: { ownerId: string }
): ReferralCodeCreation | null {
  const data = readEnvelope(value)
  if (!data || !hasExactKeys(data, ['mutation']) || !isRecord(data.mutation)) return null

  const mutation = data.mutation
  if (
    !hasExactKeys(mutation, [
      'action',
      'code_source',
      'owner_id',
      'referral_code',
      'referral_link',
    ]) ||
    mutation.action !== 'create' ||
    mutation.code_source !== 'custom' ||
    !isCanonicalUuid(expected.ownerId) ||
    mutation.owner_id !== expected.ownerId ||
    typeof mutation.referral_code !== 'string' ||
    !/^ra_[0-9a-f]{32}$/.test(mutation.referral_code) ||
    mutation.referral_link !== expectedReferralLink(mutation.referral_code)
  ) {
    return null
  }

  return {
    ownerId: mutation.owner_id,
    referralCode: mutation.referral_code,
    referralLink: mutation.referral_link,
    codeSource: 'custom',
  }
}
