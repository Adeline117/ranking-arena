const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const REFERRAL_CODE_PATTERN = /^[A-Za-z0-9_-]{2,64}$/
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/

type JsonRecord = Record<string, unknown>

export type ReferralApplyAcknowledgement = Readonly<{
  status: 'applied' | 'already_applied'
  referredId: string
  referrerId: string
  attributionId: string
  created: boolean
  code: string
  referrerHandle: string
}>

export type TerminalReferralApplyErrorCode =
  | 'REFERRAL_INVALID_CODE'
  | 'REFERRAL_SELF_REFERRAL'
  | 'REFERRAL_CODE_NOT_FOUND'
  | 'REFERRAL_CODE_AMBIGUOUS'
  | 'REFERRAL_ALREADY_ATTRIBUTED'

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(value: JsonRecord, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const canonical = [...expected].sort()
  return (
    actual.length === canonical.length && actual.every((key, index) => key === canonical[index])
  )
}

function isCanonicalUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value)
}

function isNormalizedReferralCode(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value === value.trim() &&
    value === value.normalize('NFC') &&
    REFERRAL_CODE_PATTERN.test(value)
  )
}

function isNormalizedReferrerHandle(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    Array.from(value).length <= 64 &&
    value === value.trim() &&
    value === value.normalize('NFC') &&
    !CONTROL_PATTERN.test(value)
  )
}

export function readReferralApplyAcknowledgement(
  value: unknown,
  expected: { viewerId: string; code: string }
): ReferralApplyAcknowledgement | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'attribution_id',
      'code',
      'created',
      'referred_id',
      'referrer_handle',
      'referrer_id',
      'status',
      'success',
    ]) ||
    value.success !== true ||
    (value.status !== 'applied' && value.status !== 'already_applied') ||
    !isCanonicalUuid(expected.viewerId) ||
    !isNormalizedReferralCode(expected.code) ||
    value.referred_id !== expected.viewerId ||
    !isCanonicalUuid(value.referrer_id) ||
    value.referrer_id === expected.viewerId ||
    !isCanonicalUuid(value.attribution_id) ||
    typeof value.created !== 'boolean' ||
    (value.status === 'applied' && value.created !== true) ||
    (value.status === 'already_applied' && value.created !== false) ||
    value.code !== expected.code ||
    !isNormalizedReferralCode(value.code) ||
    !isNormalizedReferrerHandle(value.referrer_handle)
  ) {
    return null
  }

  return {
    status: value.status,
    referredId: value.referred_id,
    referrerId: value.referrer_id,
    attributionId: value.attribution_id,
    created: value.created,
    code: value.code,
    referrerHandle: value.referrer_handle,
  }
}

export function readTerminalReferralApplyError(
  value: unknown,
  status: number
): TerminalReferralApplyErrorCode | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['code', 'error', 'success']) ||
    value.success !== false ||
    typeof value.error !== 'string' ||
    value.error.length < 1 ||
    value.error.length > 200 ||
    value.error !== value.error.trim()
  ) {
    return null
  }

  if (
    status === 400 &&
    (value.code === 'REFERRAL_INVALID_CODE' || value.code === 'REFERRAL_SELF_REFERRAL')
  ) {
    return value.code
  }
  if (status === 404 && value.code === 'REFERRAL_CODE_NOT_FOUND') return value.code
  if (
    status === 409 &&
    (value.code === 'REFERRAL_CODE_AMBIGUOUS' || value.code === 'REFERRAL_ALREADY_ATTRIBUTED')
  ) {
    return value.code
  }
  return null
}
