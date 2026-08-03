/** Recover an account during its 30-day deletion grace period. */

import { createHash, createHmac, randomUUID } from 'node:crypto'
import { NextResponse } from 'next/server'
import { withPublic } from '@/lib/api/middleware'
import { badRequest } from '@/lib/api/response'
import { isAccountRecoveryToken } from '@/lib/auth/account-recovery-token'
import { env } from '@/lib/env'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { createLogger } from '@/lib/utils/logger'
import { getStripe } from '@/lib/stripe'
import {
  B2CSubscriptionRecoveryIdentityConflictError,
  B2CSubscriptionRecoveryWriteUncertainError,
  recoverExactB2CSubscriptionRenewal,
  stopExactFrozenB2CSubscriptionForCompensation,
  type B2CSubscriptionAuthorityKind,
  type ExactFrozenB2CSubscriptionCompensationStopResult,
  type ExactB2CSubscriptionRecoveryObservation,
} from '@/lib/stripe/account-deletion'

const logger = createLogger('account-recover')
const INVALID_RECOVERY = 'Invalid credentials or no pending deletion'
const FINALIZATION_COOKIE_PREFIX = 'arena_recovery_'
const RECOVERY_FALLBACK_COOKIE_PREFIX = 'arena_account_recovery_'
const FINALIZATION_TTL_SECONDS = 30 * 24 * 60 * 60
const FINALIZATION_CAPABILITY_DOMAIN = 'account-recovery-finalization:v2'
const MIN_FINALIZATION_SECRET_LENGTH = 32
const MAX_FINALIZATION_SECRET_LENGTH = 4_096
const MIN_FINALIZATION_SECRET_DISTINCT_CHARACTERS = 8
const INVALID_FINALIZATION_SECRET_CHARACTER_PATTERN = /[^\x21-\x7e]/
const FAIL_CLOSED_AUTH_BAN_DURATION = '876000h'
const FAIL_CLOSED_AUTH_BAN_MINIMUM_MS = 99 * 365 * 24 * 60 * 60 * 1_000

function requireStripeLivemode(): boolean {
  const key = env.STRIPE_SECRET_KEY?.trim()
  if (key?.startsWith('sk_live_')) return true
  if (key?.startsWith('sk_test_')) return false
  throw new Error('STRIPE_SECRET_KEY mode is unavailable')
}

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

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

async function reban(
  userId: string,
  banDuration = FAIL_CLOSED_AUTH_BAN_DURATION
): Promise<boolean> {
  const { error } = await getSupabaseAdmin().auth.admin.updateUserById(userId, {
    ban_duration: banDuration,
  })
  if (error) {
    logger.error('Failed to restore deletion ban after recovery failure', { userId, error })
    return false
  }
  return true
}

async function verifyAuthBanState(
  userId: string,
  shouldBeBanned: boolean,
  minimumBannedUntil?: number
): Promise<boolean> {
  const { data, error } = await getSupabaseAdmin().auth.admin.getUserById(userId)
  if (error || !data.user) {
    logger.error('Failed to fresh-read Auth ban state', { userId, error })
    return false
  }
  const bannedUntil = data.user.banned_until ? Date.parse(data.user.banned_until) : Number.NaN
  if (data.user.banned_until && !Number.isFinite(bannedUntil)) return false
  const isBanned = Number.isFinite(bannedUntil) && bannedUntil > Date.now()
  return (
    isBanned === shouldBeBanned &&
    (!shouldBeBanned ||
      minimumBannedUntil === undefined ||
      (Number.isFinite(bannedUntil) && bannedUntil >= minimumBannedUntil))
  )
}

type RecoveryClaimAck = 'claimed' | 'busy' | 'finished' | 'invalid'
type RecoveryPrepareAck = 'prepared' | 'busy' | 'finished' | 'invalid'
type RecoveryFinishAck = 'finished' | 'aborted' | 'absent' | 'invalid'
type RecoveryAbortAck = 'aborted' | 'finished' | 'absent'
type AuthFinalizationClaimAck =
  | 'claimed'
  | 'busy'
  | 'compensation_auth_only'
  | 'compensation_billing'
  | 'billing_pending'
  | 'completed_resumed'
  | 'completed_manual'
  | 'invalid'
type AuthFinalizationFinishAck =
  | 'finalized'
  | 'already_finalized'
  | 'compensation_auth_only'
  | 'invalid'
interface RecoveryRpcResult {
  data: unknown
  error: { message: string } | null
}

interface RecoveryFinalizationCapability {
  userId: string
  operationId: string
  capability: string
  fallbackOperationId: string | null
}

interface RecoveryFinalizationSecrets {
  current: string
  previous: string | null
}

type RecoveryReacquisitionState =
  | 'prepared'
  | 'pending'
  | 'claimed'
  | 'auth_compensation_required'
  | 'billing_pending'

type RecoveryReacquisitionLocator =
  | { status: 'absent' | 'invalid' | 'unavailable' }
  | {
      status: 'located'
      userId: string
      operationId: string
      reacquisitionId: string
      reacquisitionProof: string
    }

type RecoveryReacquisitionAttestation =
  | { status: 'invalid' }
  | {
      status: 'reacquired'
      userId: string
      operationId: string
      candidateIndex: 0 | 1
      authFinalizationState: RecoveryReacquisitionState
    }

type RecoveryReacquisitionStatus = 'available' | 'unavailable' | 'invalid'

function isOperationId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  )
}

function finalizationCookieName(operationId: string): string {
  return `${FINALIZATION_COOKIE_PREFIX}${operationId}`
}

function validateRecoveryFinalizationSecret(name: string, value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < MIN_FINALIZATION_SECRET_LENGTH ||
    value.length > MAX_FINALIZATION_SECRET_LENGTH
  ) {
    throw new Error(
      `${name} must contain between ${MIN_FINALIZATION_SECRET_LENGTH} and ${MAX_FINALIZATION_SECRET_LENGTH} characters`
    )
  }
  if (INVALID_FINALIZATION_SECRET_CHARACTER_PATTERN.test(value)) {
    throw new Error(`${name} must contain only printable non-whitespace ASCII characters`)
  }
  if (new Set(value).size < MIN_FINALIZATION_SECRET_DISTINCT_CHARACTERS) {
    throw new Error(
      `${name} must contain at least ${MIN_FINALIZATION_SECRET_DISTINCT_CHARACTERS} distinct characters`
    )
  }
  return value
}

function readRecoveryFinalizationSecrets(): RecoveryFinalizationSecrets {
  const current = validateRecoveryFinalizationSecret(
    'ACCOUNT_RECOVERY_FINALIZATION_SECRET',
    env.ACCOUNT_RECOVERY_FINALIZATION_SECRET
  )
  const previous =
    env.ACCOUNT_RECOVERY_FINALIZATION_SECRET_PREVIOUS === undefined
      ? null
      : validateRecoveryFinalizationSecret(
          'ACCOUNT_RECOVERY_FINALIZATION_SECRET_PREVIOUS',
          env.ACCOUNT_RECOVERY_FINALIZATION_SECRET_PREVIOUS
        )
  if (previous === current) {
    throw new Error(
      'ACCOUNT_RECOVERY_FINALIZATION_SECRET_PREVIOUS must differ from ACCOUNT_RECOVERY_FINALIZATION_SECRET'
    )
  }
  const serviceRole = env.SUPABASE_SERVICE_ROLE_KEY
  if (typeof serviceRole === 'string' && serviceRole.length > 0) {
    if (current === serviceRole) {
      throw new Error(
        'ACCOUNT_RECOVERY_FINALIZATION_SECRET must differ from SUPABASE_SERVICE_ROLE_KEY'
      )
    }
    if (previous === serviceRole) {
      throw new Error(
        'ACCOUNT_RECOVERY_FINALIZATION_SECRET_PREVIOUS must differ from SUPABASE_SERVICE_ROLE_KEY'
      )
    }
  }
  return { current, previous }
}

function deriveFinalizationCapabilityWithSecret(
  userId: string,
  operationId: string,
  secret: string
): string {
  return createHmac('sha256', secret)
    .update(`${FINALIZATION_CAPABILITY_DOMAIN}:${userId}:${operationId}`)
    .digest('base64url')
}

/** Current-first key ring for a future authenticated capability reacquire flow. */
function deriveFinalizationCapabilityCandidates(
  userId: string,
  operationId: string,
  secrets: RecoveryFinalizationSecrets = readRecoveryFinalizationSecrets()
): [string, ...string[]] {
  const candidates: [string, ...string[]] = [
    deriveFinalizationCapabilityWithSecret(userId, operationId, secrets.current),
  ]
  if (secrets.previous) {
    candidates.push(deriveFinalizationCapabilityWithSecret(userId, operationId, secrets.previous))
  }
  return candidates
}

function hashFinalizationCapability(capability: string): string {
  return createHash('sha256').update(capability).digest('hex')
}

function serializeFinalizationCapability(value: RecoveryFinalizationCapability): string {
  const payload = Buffer.from(
    JSON.stringify({
      v: 1,
      u: value.userId,
      o: value.operationId,
      c: value.capability,
      d: value.fallbackOperationId,
    })
  ).toString('base64url')
  return payload
}

function parseFinalizationCapability(value: unknown): RecoveryFinalizationCapability | null {
  if (typeof value !== 'string' || value.length < 40 || value.length > 1_024) return null
  try {
    const payload = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >
    if (
      Object.keys(payload).length !== 5 ||
      payload.v !== 1 ||
      typeof payload.u !== 'string' ||
      !isOperationId(payload.u) ||
      typeof payload.o !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        payload.o
      ) ||
      typeof payload.c !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(payload.c) ||
      (payload.d !== null && !isOperationId(payload.d))
    ) {
      return null
    }
    return {
      userId: payload.u,
      operationId: payload.o,
      capability: payload.c,
      fallbackOperationId: payload.d,
    }
  } catch {
    return null
  }
}

function readFinalizationCookie(request: Request, operationId: string): string | null {
  return readCookieValue(request, finalizationCookieName(operationId))
}

function readCookieValue(request: Request, cookieName: string): string | null {
  const cookie = request.headers.get('cookie')
  if (!cookie) return null
  for (const pair of cookie.split(';')) {
    const separator = pair.indexOf('=')
    if (separator < 0 || pair.slice(0, separator).trim() !== cookieName) continue
    try {
      return decodeURIComponent(pair.slice(separator + 1).trim())
    } catch {
      return null
    }
  }
  return null
}

function fallbackRecoveryCookieName(operationId: string): string {
  return `${RECOVERY_FALLBACK_COOKIE_PREFIX}${operationId}`
}

function readFallbackRecoveryCookie(request: Request, operationId: string): string | null {
  return readCookieValue(request, fallbackRecoveryCookieName(operationId))
}

function finalizationPendingResponse(capability: RecoveryFinalizationCapability): NextResponse {
  const response = NextResponse.json(
    {
      success: false,
      error: 'Recovery finalization is temporarily unavailable. Please try again.',
    },
    { status: 503 }
  )
  response.cookies.set(
    finalizationCookieName(capability.operationId),
    serializeFinalizationCapability(capability),
    {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/api/account/recover',
      maxAge: FINALIZATION_TTL_SECONDS,
    }
  )
  return noStore(response)
}

function finalizationPreparedResponse(capability: RecoveryFinalizationCapability): NextResponse {
  const response = NextResponse.json(
    { status: 'prepared', operation_id: capability.operationId },
    { status: 202 }
  )
  response.cookies.set(
    finalizationCookieName(capability.operationId),
    serializeFinalizationCapability(capability),
    {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/api/account/recover',
      maxAge: FINALIZATION_TTL_SECONDS,
    }
  )
  return noStore(response)
}

function clearFinalizationCookie(response: NextResponse, operationId: string): NextResponse {
  response.cookies.set(finalizationCookieName(operationId), '', {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    path: '/api/account/recover',
    maxAge: 0,
  })
  return noStore(response)
}

function clearFallbackRecoveryCookie(response: NextResponse, operationId: string): NextResponse {
  response.cookies.set(fallbackRecoveryCookieName(operationId), '', {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    path: '/api/account/recover',
    maxAge: 0,
  })
  return noStore(response)
}

function clearSuccessfulRecoveryCredentials(
  response: NextResponse,
  capability: RecoveryFinalizationCapability
): NextResponse {
  clearFinalizationCookie(response, capability.operationId)
  if (capability.fallbackOperationId) {
    clearFallbackRecoveryCookie(response, capability.fallbackOperationId)
  }
  return noStore(response)
}

async function recoveryRpc(
  functionName: string,
  args: Record<string, unknown>
): Promise<RecoveryRpcResult> {
  const admin = getSupabaseAdmin()
  return (await Reflect.apply(admin.rpc, admin, [functionName, args])) as RecoveryRpcResult
}

async function readRecoveryReacquisitionStatus(params: {
  fallbackOperationId: string
  recoveryTokenHash: string
}): Promise<RecoveryReacquisitionStatus> {
  const { data, error } = await recoveryRpc(
    'status_account_recovery_capability_reacquisition_atomic',
    {
      p_operation_id: params.fallbackOperationId,
      p_recovery_token_hash: params.recoveryTokenHash,
    }
  )
  const parsed = parseRecoveryReacquisitionStatus(data)
  if (error || !parsed) {
    throw new Error(error?.message ?? 'Recovery reacquisition status acknowledgement was invalid')
  }
  return parsed
}

async function locateRecoveryReacquisition(params: {
  recoveryTokenHash: string | null
  email: string | null
  password: string | null
}): Promise<RecoveryReacquisitionLocator> {
  const { data, error } = await recoveryRpc(
    'locate_account_recovery_capability_reacquisition_atomic',
    {
      p_recovery_token_hash: params.recoveryTokenHash,
      p_email: params.email,
      p_password: params.password,
    }
  )
  const parsed = parseRecoveryReacquisitionLocator(data)
  if (error || !parsed) {
    throw new Error(error?.message ?? 'Recovery reacquisition locator acknowledgement was invalid')
  }
  return parsed
}

async function attestRecoveryReacquisition(params: {
  reacquisitionId: string
  reacquisitionProof: string
  currentCapabilityHash: string
  previousCapabilityHash: string | null
}): Promise<RecoveryReacquisitionAttestation> {
  const { data, error } = await recoveryRpc(
    'attest_account_recovery_capability_reacquisition_atomic',
    {
      p_reacquisition_id: params.reacquisitionId,
      p_reacquisition_proof: params.reacquisitionProof,
      p_current_capability_hash: params.currentCapabilityHash,
      p_previous_capability_hash: params.previousCapabilityHash,
    }
  )
  const parsed = parseRecoveryReacquisitionAttestation(data)
  if (error || !parsed) {
    throw new Error(
      error?.message ?? 'Recovery reacquisition attestation acknowledgement was invalid'
    )
  }
  return parsed
}

async function claimRecoveryAdmission(params: {
  userId: string
  recoveryTokenHash: string | null
  operationId: string
}): Promise<RecoveryClaimAck> {
  const { data, error } = await recoveryRpc('claim_account_recovery_with_deletion_fence_atomic', {
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

async function verifyRecoveryPassword(params: {
  userId: string
  operationId: string
  email: string
  password: string
}): Promise<'verified' | 'invalid' | 'unavailable'> {
  const { data, error } = await recoveryRpc('verify_pending_account_password_atomic', {
    p_user_id: params.userId,
    p_operation_id: params.operationId,
    p_email: params.email,
    p_password: params.password,
  })
  if (error || (data !== 'verified' && data !== 'invalid' && data !== 'unavailable')) {
    throw new Error(error?.message ?? 'Recovery password verification acknowledgement was invalid')
  }
  return data
}

async function finishRecoveryAdmission(params: {
  userId: string
  operationId: string
  capabilityHash: string
}): Promise<RecoveryFinishAck> {
  const { data, error } = await recoveryRpc(
    'finish_account_recovery_with_auth_finalization_atomic',
    {
      p_user_id: params.userId,
      p_operation_id: params.operationId,
      p_capability_hash: params.capabilityHash,
    }
  )
  if (
    error ||
    (data !== 'finished' && data !== 'aborted' && data !== 'absent' && data !== 'invalid')
  ) {
    throw new Error(error?.message ?? 'Recovery finish returned an invalid acknowledgement')
  }
  return data
}

async function prepareRecoveryFinalization(params: {
  userId: string
  operationId: string
  capabilityHash: string
}): Promise<RecoveryPrepareAck> {
  const { data, error } = await recoveryRpc('prepare_account_recovery_auth_finalization_atomic', {
    p_user_id: params.userId,
    p_operation_id: params.operationId,
    p_capability_hash: params.capabilityHash,
  })
  if (
    error ||
    (data !== 'prepared' && data !== 'busy' && data !== 'finished' && data !== 'invalid')
  ) {
    throw new Error(error?.message ?? 'Recovery preparation returned an invalid acknowledgement')
  }
  return data
}

async function claimAuthFinalization(params: {
  userId: string
  operationId: string
  capabilityHash: string
  attemptId: string
}): Promise<AuthFinalizationClaimAck> {
  const { data, error } = await recoveryRpc('claim_account_recovery_auth_finalization_atomic', {
    p_user_id: params.userId,
    p_operation_id: params.operationId,
    p_capability_hash: params.capabilityHash,
    p_attempt_id: params.attemptId,
  })
  if (
    error ||
    (data !== 'claimed' &&
      data !== 'busy' &&
      data !== 'compensation_auth_only' &&
      data !== 'compensation_billing' &&
      data !== 'billing_pending' &&
      data !== 'completed_resumed' &&
      data !== 'completed_manual' &&
      data !== 'invalid')
  ) {
    throw new Error(error?.message ?? 'Recovery Auth claim returned an invalid acknowledgement')
  }
  return data
}

interface RecoveryB2CTarget {
  stripeSubscriptionId: string
  authorityKind: B2CSubscriptionAuthorityKind
  plan: 'monthly' | 'yearly'
  periodStart: number
  periodEnd: number
  priceId: string
  expectedAmount: number
  currency: string
}

interface RecoveryBillingTargets {
  status: 'resolved' | 'manual_review'
  stripeCustomerId: string | null
  targetDigest: string
  b2cTarget: RecoveryB2CTarget | null
  apiTargetCount: number
  retiredB2CCount: number
  unclassifiedTargetCount: number
}

interface RecoveryBillingCompensationTarget {
  status: 'compensation_billing'
  livemode: boolean
  stripeCustomerId: string | null
  targetDigest: string
  b2cTarget: RecoveryB2CTarget | null
}

type RecoveryB2CState =
  | 'active_restored'
  | 'trial_restored'
  | 'grace_restored'
  | 'no_b2c_target'
  | 'target_missing'
  | 'retired_nonentitling'
  | 'identity_conflict'
  | 'manual_review'
type RecoveryLifetimeState = 'restored' | 'not_present'
type RecoveryBillingCompletion =
  | {
      status: 'completed_resumed' | 'completed_manual'
      b2cState: RecoveryB2CState
      lifetimeState: RecoveryLifetimeState
      subscriptionResumed: boolean
      billingReactivationRequired: boolean
      targetDigest: string
    }
  | { status: 'compensation_billing' }
type RecoveryBillingResult = Exclude<RecoveryBillingCompletion, { status: 'compensation_billing' }>

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function parseRecoveryReacquisitionStatus(value: unknown): RecoveryReacquisitionStatus | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const ack = value as Record<string, unknown>
  if (!hasExactKeys(ack, ['status'])) return null
  return ack.status === 'available' || ack.status === 'unavailable' || ack.status === 'invalid'
    ? ack.status
    : null
}

function parseRecoveryReacquisitionLocator(value: unknown): RecoveryReacquisitionLocator | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const ack = value as Record<string, unknown>
  if (
    (ack.status === 'absent' || ack.status === 'invalid' || ack.status === 'unavailable') &&
    hasExactKeys(ack, ['status'])
  ) {
    return { status: ack.status }
  }
  if (
    ack.status !== 'located' ||
    !hasExactKeys(ack, [
      'status',
      'user_id',
      'operation_id',
      'reacquisition_id',
      'reacquisition_proof',
    ]) ||
    !isOperationId(ack.user_id) ||
    !isOperationId(ack.operation_id) ||
    !isOperationId(ack.reacquisition_id) ||
    typeof ack.reacquisition_proof !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(ack.reacquisition_proof)
  ) {
    return null
  }
  return {
    status: 'located',
    userId: ack.user_id,
    operationId: ack.operation_id,
    reacquisitionId: ack.reacquisition_id,
    reacquisitionProof: ack.reacquisition_proof,
  }
}

function parseRecoveryReacquisitionAttestation(
  value: unknown
): RecoveryReacquisitionAttestation | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const ack = value as Record<string, unknown>
  if (ack.status === 'invalid' && hasExactKeys(ack, ['status'])) return { status: 'invalid' }
  if (
    ack.status !== 'reacquired' ||
    !hasExactKeys(ack, [
      'status',
      'user_id',
      'operation_id',
      'candidate_index',
      'auth_finalization_state',
    ]) ||
    !isOperationId(ack.user_id) ||
    !isOperationId(ack.operation_id) ||
    (ack.candidate_index !== 0 && ack.candidate_index !== 1) ||
    !['prepared', 'pending', 'claimed', 'auth_compensation_required', 'billing_pending'].includes(
      String(ack.auth_finalization_state)
    )
  ) {
    return null
  }
  return {
    status: 'reacquired',
    userId: ack.user_id,
    operationId: ack.operation_id,
    candidateIndex: ack.candidate_index,
    authFinalizationState: ack.auth_finalization_state as RecoveryReacquisitionState,
  }
}

function exactIsoSecond(value: unknown): number | null {
  if (typeof value !== 'string' || value.length < 20 || value.length > 40) return null
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds) || milliseconds % 1_000 !== 0) return null
  const seconds = milliseconds / 1_000
  return Number.isSafeInteger(seconds) && seconds >= 0 ? seconds : null
}

type ParsedRecoveryB2CTarget = { valid: true; target: RecoveryB2CTarget | null } | { valid: false }

function parseRecoveryB2CTarget(
  value: unknown,
  stripeCustomerId: unknown
): ParsedRecoveryB2CTarget {
  if (value === null) return { valid: true, target: null }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { valid: false }

  const target = value as Record<string, unknown>
  const periodStart = exactIsoSecond(target.period_start)
  const periodEnd = exactIsoSecond(target.period_end)
  if (
    !hasExactKeys(target, [
      'stripe_subscription_id',
      'authority_kind',
      'plan',
      'period_start',
      'period_end',
      'stripe_price_id',
      'expected_amount',
      'currency',
    ]) ||
    typeof target.stripe_subscription_id !== 'string' ||
    !/^sub_[A-Za-z0-9_]+$/.test(target.stripe_subscription_id) ||
    target.stripe_subscription_id.length > 255 ||
    (target.authority_kind !== 'paid' && target.authority_kind !== 'trial') ||
    (target.plan !== 'monthly' && target.plan !== 'yearly') ||
    periodStart === null ||
    periodEnd === null ||
    periodEnd <= periodStart ||
    typeof target.stripe_price_id !== 'string' ||
    !/^price_[A-Za-z0-9_]+$/.test(target.stripe_price_id) ||
    target.stripe_price_id.length > 255 ||
    !Number.isSafeInteger(target.expected_amount) ||
    (target.expected_amount as number) <= 0 ||
    typeof target.currency !== 'string' ||
    !/^[a-z]{3}$/.test(target.currency) ||
    typeof stripeCustomerId !== 'string'
  ) {
    return { valid: false }
  }

  return {
    valid: true,
    target: {
      stripeSubscriptionId: target.stripe_subscription_id,
      authorityKind: target.authority_kind,
      plan: target.plan,
      periodStart,
      periodEnd,
      priceId: target.stripe_price_id,
      expectedAmount: target.expected_amount as number,
      currency: target.currency,
    },
  }
}

function parseRecoveryBillingTargets(value: unknown): RecoveryBillingTargets | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const ack = value as Record<string, unknown>
  if (ack.status === 'invalid' && hasExactKeys(ack, ['status'])) return null
  if (
    (ack.status !== 'resolved' && ack.status !== 'manual_review') ||
    !hasExactKeys(ack, [
      'status',
      'stripe_customer_id',
      'target_digest',
      'b2c_target',
      'api_target_count',
      'retired_b2c_count',
      'unclassified_target_count',
    ]) ||
    (ack.stripe_customer_id !== null &&
      (typeof ack.stripe_customer_id !== 'string' ||
        !/^cus_[A-Za-z0-9_]+$/.test(ack.stripe_customer_id) ||
        ack.stripe_customer_id.length > 255)) ||
    typeof ack.target_digest !== 'string' ||
    !/^[0-9a-f]{64}$/.test(ack.target_digest) ||
    ![ack.api_target_count, ack.retired_b2c_count, ack.unclassified_target_count].every(
      (count) => Number.isSafeInteger(count) && (count as number) >= 0
    )
  ) {
    return null
  }

  const parsedTarget = parseRecoveryB2CTarget(ack.b2c_target, ack.stripe_customer_id)
  if (!parsedTarget.valid) return null
  const b2cTarget = parsedTarget.target
  if (ack.status === 'manual_review' && b2cTarget !== null) return null

  return {
    status: ack.status,
    stripeCustomerId: ack.stripe_customer_id,
    targetDigest: ack.target_digest,
    b2cTarget,
    apiTargetCount: ack.api_target_count as number,
    retiredB2CCount: ack.retired_b2c_count as number,
    unclassifiedTargetCount: ack.unclassified_target_count as number,
  }
}

function parseRecoveryBillingCompensationTarget(
  value: unknown
): RecoveryBillingCompensationTarget | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const ack = value as Record<string, unknown>
  if (
    ack.status !== 'compensation_billing' ||
    !hasExactKeys(ack, [
      'status',
      'livemode',
      'stripe_customer_id',
      'target_digest',
      'b2c_target',
    ]) ||
    typeof ack.livemode !== 'boolean' ||
    (ack.stripe_customer_id !== null &&
      (typeof ack.stripe_customer_id !== 'string' ||
        !/^cus_[A-Za-z0-9_]+$/.test(ack.stripe_customer_id) ||
        ack.stripe_customer_id.length > 255)) ||
    typeof ack.target_digest !== 'string' ||
    !/^[0-9a-f]{64}$/.test(ack.target_digest)
  ) {
    return null
  }

  const parsedTarget = parseRecoveryB2CTarget(ack.b2c_target, ack.stripe_customer_id)
  if (!parsedTarget.valid) return null
  return {
    status: 'compensation_billing',
    livemode: ack.livemode,
    stripeCustomerId: ack.stripe_customer_id,
    targetDigest: ack.target_digest,
    b2cTarget: parsedTarget.target,
  }
}

function parseRecoveryBillingCompletion(value: unknown): RecoveryBillingCompletion | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const ack = value as Record<string, unknown>
  if (ack.status === 'invalid' && hasExactKeys(ack, ['status'])) return null
  if (ack.status === 'compensation_billing' && hasExactKeys(ack, ['status'])) {
    return { status: 'compensation_billing' }
  }
  if (
    (ack.status !== 'completed_resumed' && ack.status !== 'completed_manual') ||
    !hasExactKeys(ack, [
      'status',
      'b2c_state',
      'lifetime_state',
      'subscription_resumed',
      'billing_reactivation_required',
      'target_digest',
    ]) ||
    ![
      'active_restored',
      'trial_restored',
      'grace_restored',
      'no_b2c_target',
      'target_missing',
      'retired_nonentitling',
      'identity_conflict',
      'manual_review',
    ].includes(String(ack.b2c_state)) ||
    (ack.lifetime_state !== 'restored' && ack.lifetime_state !== 'not_present') ||
    typeof ack.subscription_resumed !== 'boolean' ||
    typeof ack.billing_reactivation_required !== 'boolean' ||
    ack.subscription_resumed === ack.billing_reactivation_required ||
    (ack.status === 'completed_resumed') !== ack.subscription_resumed ||
    typeof ack.target_digest !== 'string' ||
    !/^[0-9a-f]{64}$/.test(ack.target_digest)
  ) {
    return null
  }
  return {
    status: ack.status,
    b2cState: ack.b2c_state as RecoveryB2CState,
    lifetimeState: ack.lifetime_state,
    subscriptionResumed: ack.subscription_resumed,
    billingReactivationRequired: ack.billing_reactivation_required,
    targetDigest: ack.target_digest,
  }
}

async function resolveRecoveryBillingTargets(params: {
  userId: string
  operationId: string
  capabilityHash: string
  attemptId: string
  livemode: boolean
}): Promise<RecoveryBillingTargets> {
  const { data, error } = await recoveryRpc('resolve_account_recovery_billing_targets_v2_atomic', {
    p_user_id: params.userId,
    p_operation_id: params.operationId,
    p_capability_hash: params.capabilityHash,
    p_attempt_id: params.attemptId,
    p_livemode: params.livemode,
  })
  const parsed = parseRecoveryBillingTargets(data)
  if (error || !parsed) {
    throw new Error(
      error?.message ?? 'Recovery billing targets returned an invalid acknowledgement'
    )
  }
  return parsed
}

async function completeRecoveryBilling(params: {
  userId: string
  operationId: string
  capabilityHash: string
  attemptId: string
  livemode: boolean
  targetDigest: string
  b2cObservation: ExactB2CSubscriptionRecoveryObservation | null
}): Promise<RecoveryBillingCompletion> {
  const { data, error } = await recoveryRpc('complete_account_recovery_billing_v2_atomic', {
    p_user_id: params.userId,
    p_operation_id: params.operationId,
    p_capability_hash: params.capabilityHash,
    p_attempt_id: params.attemptId,
    p_livemode: params.livemode,
    p_target_digest: params.targetDigest,
    p_b2c_observation: params.b2cObservation,
  })
  const parsed = parseRecoveryBillingCompletion(data)
  if (
    error ||
    !parsed ||
    (parsed.status !== 'compensation_billing' && parsed.targetDigest !== params.targetDigest)
  ) {
    throw new Error(
      error?.message ?? 'Recovery billing completion returned an invalid acknowledgement'
    )
  }
  return parsed
}

async function readRecoveryBillingResult(params: {
  userId: string
  operationId: string
  capabilityHash: string
}): Promise<RecoveryBillingResult> {
  const { data, error } = await recoveryRpc('read_account_recovery_billing_result_v2_atomic', {
    p_user_id: params.userId,
    p_operation_id: params.operationId,
    p_capability_hash: params.capabilityHash,
  })
  const parsed = parseRecoveryBillingCompletion(data)
  if (error || !parsed || parsed.status === 'compensation_billing') {
    throw new Error(error?.message ?? 'Recovery billing replay result was unavailable')
  }
  return parsed
}

async function readRecoveryBillingCompensationTarget(params: {
  userId: string
  operationId: string
  capabilityHash: string
  attemptId: string
}): Promise<RecoveryBillingCompensationTarget> {
  const { data, error } = await recoveryRpc(
    'read_account_recovery_billing_compensation_target_v2_atomic',
    {
      p_user_id: params.userId,
      p_operation_id: params.operationId,
      p_capability_hash: params.capabilityHash,
      p_attempt_id: params.attemptId,
    }
  )
  const parsed = parseRecoveryBillingCompensationTarget(data)
  if (error || !parsed) {
    throw new Error(
      error?.message ?? 'Recovery billing compensation target was unavailable or invalid'
    )
  }
  return parsed
}

async function armRecoveryBilling(params: {
  userId: string
  operationId: string
  capabilityHash: string
  attemptId: string
}): Promise<'armed' | 'invalid'> {
  const { data, error } = await recoveryRpc('arm_account_recovery_billing_atomic', {
    p_user_id: params.userId,
    p_operation_id: params.operationId,
    p_capability_hash: params.capabilityHash,
    p_attempt_id: params.attemptId,
  })
  if (error || (data !== 'armed' && data !== 'invalid')) {
    throw new Error(error?.message ?? 'Recovery billing arm acknowledgement was invalid')
  }
  return data
}

async function resolveCompensationScope(params: {
  userId: string
  operationId: string
  capabilityHash: string
  attemptId: string
}): Promise<'billing_stop_required' | 'auth_only' | 'invalid'> {
  const { data, error } = await recoveryRpc('resolve_account_recovery_compensation_scope_atomic', {
    p_user_id: params.userId,
    p_operation_id: params.operationId,
    p_capability_hash: params.capabilityHash,
    p_attempt_id: params.attemptId,
  })
  if (error || !['billing_stop_required', 'auth_only', 'invalid'].includes(String(data))) {
    throw new Error(error?.message ?? 'Recovery compensation scope acknowledgement was invalid')
  }
  return data as 'billing_stop_required' | 'auth_only' | 'invalid'
}

async function finalizeAuthFinalization(params: {
  userId: string
  operationId: string
  capabilityHash: string
  attemptId: string
}): Promise<AuthFinalizationFinishAck> {
  const { data, error } = await recoveryRpc('finalize_account_recovery_auth_atomic', {
    p_user_id: params.userId,
    p_operation_id: params.operationId,
    p_capability_hash: params.capabilityHash,
    p_attempt_id: params.attemptId,
  })
  if (
    error ||
    (data !== 'finalized' &&
      data !== 'already_finalized' &&
      data !== 'compensation_auth_only' &&
      data !== 'invalid')
  ) {
    throw new Error(error?.message ?? 'Recovery Auth finalize returned an invalid acknowledgement')
  }
  return data
}

async function completeAuthCompensation(params: {
  userId: string
  operationId: string
  capabilityHash: string
  attemptId: string
}): Promise<'compensated' | 'invalid'> {
  const { data, error } = await recoveryRpc('complete_account_recovery_auth_compensation_atomic', {
    p_user_id: params.userId,
    p_operation_id: params.operationId,
    p_capability_hash: params.capabilityHash,
    p_attempt_id: params.attemptId,
  })
  if (error || (data !== 'compensated' && data !== 'invalid')) {
    throw new Error(error?.message ?? 'Recovery Auth compensation acknowledgement was invalid')
  }
  return data
}

async function requireAuthCompensation(params: {
  userId: string
  operationId: string
  capabilityHash: string
  attemptId: string
}): Promise<
  | 'compensation_auth_only'
  | 'compensation_billing'
  | 'completed_resumed'
  | 'completed_manual'
  | 'busy'
  | 'invalid'
> {
  const { data, error } = await recoveryRpc('require_account_recovery_auth_compensation_atomic', {
    p_user_id: params.userId,
    p_operation_id: params.operationId,
    p_capability_hash: params.capabilityHash,
    p_attempt_id: params.attemptId,
  })
  if (
    error ||
    ![
      'compensation_auth_only',
      'compensation_billing',
      'completed_resumed',
      'completed_manual',
      'busy',
      'invalid',
    ].includes(String(data))
  ) {
    throw new Error(error?.message ?? 'Recovery Auth compensation requirement was invalid')
  }
  return data as
    | 'compensation_auth_only'
    | 'compensation_billing'
    | 'completed_resumed'
    | 'completed_manual'
    | 'busy'
    | 'invalid'
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
  targets: RecoveryBillingTargets
  observation: ExactB2CSubscriptionRecoveryObservation | null
}

async function resumeSubscription(params: {
  userId: string
  livemode: boolean
  targets: RecoveryBillingTargets
}): Promise<BillingRecoveryState> {
  const { targets } = params
  if (targets.status === 'manual_review' || !targets.b2cTarget) {
    return { targets, observation: null }
  }
  if (!targets.stripeCustomerId) {
    throw new Error('Exact B2C recovery target has no durable Stripe customer')
  }
  const target = targets.b2cTarget
  const observation = await recoverExactB2CSubscriptionRenewal({
    stripeClient: getStripe(),
    subscriptionId: target.stripeSubscriptionId,
    expectedCustomerId: targets.stripeCustomerId,
    expectedUserId: params.userId,
    livemode: params.livemode,
    authorityKind: target.authorityKind,
    plan: target.plan,
    periodStart: target.periodStart,
    periodEnd: target.periodEnd,
    priceId: target.priceId,
    expectedAmount: target.expectedAmount,
    currency: target.currency,
    pauseMarker: params.userId,
  })
  return { targets, observation }
}

function assertCurrentStripeMode(expectedLivemode: boolean): void {
  if (requireStripeLivemode() !== expectedLivemode) {
    throw new Error('Frozen recovery billing target belongs to a different Stripe mode')
  }
}

async function stopExactRecoveredB2CBillingForCompensation(
  userId: string,
  exactTarget: { subscriptionId: string; customerId: string; livemode: boolean }
): Promise<ExactFrozenB2CSubscriptionCompensationStopResult> {
  assertCurrentStripeMode(exactTarget.livemode)
  return stopExactFrozenB2CSubscriptionForCompensation({
    stripeClient: getStripe(),
    subscriptionId: exactTarget.subscriptionId,
    customerId: exactTarget.customerId,
    expectedUserId: userId,
    livemode: exactTarget.livemode,
  })
}

interface CompensationBanPolicy {
  duration: string
  minimumBannedUntil: number
}

async function resolveCompensationBanDuration(_userId: string): Promise<CompensationBanPolicy> {
  // Compensation always returns the recovery operation to a non-finalized
  // state. Keep Auth fail-closed until an explicit successful recovery unbans
  // it; a cron-sized retry ban creates gaps once the queue exceeds one page.
  return {
    duration: FAIL_CLOSED_AUTH_BAN_DURATION,
    minimumBannedUntil: Date.now() + FAIL_CLOSED_AUTH_BAN_MINIMUM_MS,
  }
}

const recoveryHandler = async ({ request }: { request: Request }) => {
  let body: {
    email?: string
    password?: string
    recovery_token?: string
    recovery_cookie?: boolean
    recovery_cookie_operation_id?: string
    operation_id?: string
  }
  try {
    body = await request.json()
  } catch {
    return badRequest('Invalid JSON body')
  }

  const phase = new URL(request.url).searchParams.get('phase')
  if (phase !== null && phase !== 'commit' && phase !== 'status' && phase !== 'fallback-status') {
    return noStore(NextResponse.json({ error: 'Invalid recovery phase' }, { status: 400 }))
  }
  if (phase === 'status') {
    if (!isSameOriginBrowserRequest(request)) {
      return noStore(NextResponse.json({ operations: [] }, { status: 401 }))
    }
    const rawCookie = request.headers.get('cookie') ?? ''
    if (rawCookie.length > 16_384) {
      return noStore(NextResponse.json({ operations: [] }, { status: 431 }))
    }
    const candidates: RecoveryFinalizationCapability[] = []
    for (const pair of rawCookie.split(';')) {
      const separator = pair.indexOf('=')
      const name = separator < 0 ? '' : pair.slice(0, separator).trim()
      if (!name.startsWith(FINALIZATION_COOKIE_PREFIX)) continue
      const operationId = name.slice(FINALIZATION_COOKIE_PREFIX.length)
      if (!isOperationId(operationId) || candidates.length >= 10) continue
      let value: string
      try {
        value = decodeURIComponent(pair.slice(separator + 1).trim())
      } catch {
        continue
      }
      const parsed = parseFinalizationCapability(value)
      if (parsed?.operationId === operationId) candidates.push(parsed)
    }
    const operations: Array<{ operation_id: string; state: string }> = []
    for (const candidate of candidates) {
      const { data, error } = await recoveryRpc('resolve_account_recovery_capability_atomic', {
        p_user_id: candidate.userId,
        p_operation_id: candidate.operationId,
        p_capability_hash: hashFinalizationCapability(candidate.capability),
      })
      if (error) {
        logger.error('Recovery capability discovery authority was unavailable', {
          operationId: candidate.operationId,
          error: error.message,
        })
        return noStore(
          NextResponse.json({ operations: [], error: 'Status unavailable' }, { status: 503 })
        )
      }
      if (typeof data === 'string' && data !== 'invalid') {
        operations.push({ operation_id: candidate.operationId, state: data })
      }
    }
    return noStore(NextResponse.json({ operations }))
  }
  if (phase === 'fallback-status') {
    if (!isSameOriginBrowserRequest(request)) {
      return noStore(NextResponse.json({ available: false }, { status: 401 }))
    }
    const rawCookie = request.headers.get('cookie') ?? ''
    if (rawCookie.length > 16_384) {
      return noStore(NextResponse.json({ available: false, operations: [] }, { status: 431 }))
    }
    const candidates = new Map<string, string>()
    for (const pair of rawCookie.split(';')) {
      const separator = pair.indexOf('=')
      const name = separator < 0 ? '' : pair.slice(0, separator).trim()
      if (!name.startsWith(RECOVERY_FALLBACK_COOKIE_PREFIX) || candidates.size >= 10) continue
      const operationId = name.slice(RECOVERY_FALLBACK_COOKIE_PREFIX.length)
      if (!isOperationId(operationId)) continue
      try {
        candidates.set(operationId, decodeURIComponent(pair.slice(separator + 1).trim()))
      } catch {
        candidates.set(operationId, '')
      }
    }
    const operations: Array<{ operation_id: string }> = []
    const invalidOperationIds: string[] = []
    for (const [operationId, rawFallback] of candidates) {
      if (!isAccountRecoveryToken(rawFallback)) {
        invalidOperationIds.push(operationId)
        continue
      }
      const fallbackHash = createHash('sha256').update(rawFallback).digest('hex')
      let status: RecoveryReacquisitionStatus
      try {
        status = await readRecoveryReacquisitionStatus({
          fallbackOperationId: operationId,
          recoveryTokenHash: fallbackHash,
        })
      } catch (error) {
        logger.error('Recovery fallback capability status authority was unavailable', {
          operationId,
          error: error instanceof Error ? error.message : String(error),
        })
        return noStore(
          NextResponse.json(
            { available: false, operations: [], error: 'Status unavailable' },
            { status: 503 }
          )
        )
      }
      if (status === 'available') operations.push({ operation_id: operationId })
      else invalidOperationIds.push(operationId)
    }
    operations.sort((left, right) => left.operation_id.localeCompare(right.operation_id))
    const response = NextResponse.json({ available: operations.length > 0, operations })
    for (const operationId of invalidOperationIds)
      clearFallbackRecoveryCookie(response, operationId)
    return noStore(response)
  }
  const requestedOperationId = isOperationId(body.operation_id) ? body.operation_id : null
  const finalizationCapability = requestedOperationId
    ? parseFinalizationCapability(readFinalizationCookie(request, requestedOperationId))
    : null
  const isCommitPhase = phase === 'commit'

  if (
    isCommitPhase &&
    (!finalizationCapability ||
      !isSameOriginBrowserRequest(request) ||
      body.operation_id !== finalizationCapability.operationId)
  ) {
    return noStore(
      NextResponse.json(
        { success: false, code: 'capability_missing', error: INVALID_RECOVERY },
        { status: 409 }
      )
    )
  }
  if (!isCommitPhase && !requestedOperationId) {
    return badRequest('A valid recovery operation_id is required')
  }

  let finalizationSecrets: RecoveryFinalizationSecrets | null = null
  if (!isCommitPhase) {
    try {
      finalizationSecrets = readRecoveryFinalizationSecrets()
    } catch (error) {
      logger.error('Account recovery finalization secret configuration is invalid', {
        error: error instanceof Error ? error.message : String(error),
      })
      return noStore(
        NextResponse.json(
          { success: false, error: 'Recovery is temporarily unavailable. Please try again.' },
          { status: 503 }
        )
      )
    }
  }

  // Construct the privileged client only after the dedicated finalization key
  // ring has passed validation for a new recovery. A broken key deployment
  // must fail before credential/token locator setup. Commit retries deliberately
  // remain capability-only and do not read the key ring.
  const admin = getSupabaseAdmin()

  // Commit is capability-only. The credential/token was verified during the
  // preparation request, and PostgreSQL binds this unforgeable value to the
  // exact claimed admission. This also makes a post-restore crash retryable
  // after the one-time recovery token has been consumed.
  if (isCommitPhase && finalizationCapability) {
    const { userId, operationId, capability } = finalizationCapability
    const capabilityHash = hashFinalizationCapability(capability)
    let finishAck: RecoveryFinishAck
    try {
      finishAck = await finishRecoveryAdmission({ userId, operationId, capabilityHash })
    } catch (error) {
      logger.error('Recovery commit acknowledgement is unavailable', {
        userId,
        operationId,
        error: error instanceof Error ? error.message : String(error),
      })
      return finalizationPendingResponse(finalizationCapability)
    }
    if (finishAck !== 'finished') {
      return clearFinalizationCookie(
        NextResponse.json(
          { success: false, code: 'capability_invalid', error: INVALID_RECOVERY },
          { status: 410 }
        ),
        operationId
      )
    }

    const attemptId = randomUUID()
    let authClaimAck: AuthFinalizationClaimAck
    try {
      authClaimAck = await claimAuthFinalization({
        userId,
        operationId,
        capabilityHash,
        attemptId,
      })
    } catch (error) {
      logger.error('Failed to claim recovery Auth finalization', {
        userId,
        operationId,
        error: error instanceof Error ? error.message : String(error),
      })
      return finalizationPendingResponse(finalizationCapability)
    }
    if (authClaimAck === 'busy') return finalizationPendingResponse(finalizationCapability)
    const compensateModerationBan = async (
      knownScope?: 'auth_only' | 'billing_stop_required'
    ): Promise<NextResponse> => {
      let scope: 'auth_only' | 'billing_stop_required'
      let billingTarget: RecoveryBillingCompensationTarget | null = null
      let billingTargetError: unknown = null
      try {
        const resolvedScope = await resolveCompensationScope({
          userId,
          operationId,
          capabilityHash,
          attemptId,
        })
        if (
          resolvedScope === 'invalid' ||
          (knownScope !== undefined && knownScope !== resolvedScope)
        ) {
          return finalizationPendingResponse(finalizationCapability)
        }
        scope = resolvedScope
      } catch (error) {
        logger.error('Failed to resolve durable recovery compensation scope', {
          userId,
          operationId,
          error: error instanceof Error ? error.message : String(error),
        })
        return finalizationPendingResponse(finalizationCapability)
      }
      if (scope === 'billing_stop_required') {
        try {
          billingTarget = await readRecoveryBillingCompensationTarget({
            userId,
            operationId,
            capabilityHash,
            attemptId,
          })
        } catch (error) {
          billingTargetError = error
        }
      }
      let banPolicy: CompensationBanPolicy | null
      try {
        banPolicy = await resolveCompensationBanDuration(userId)
      } catch (error) {
        logger.error('Failed to resolve recovery Auth compensation policy', {
          userId,
          operationId,
          error: error instanceof Error ? error.message : String(error),
        })
        return finalizationPendingResponse(finalizationCapability)
      }
      if (banPolicy && !(await reban(userId, banPolicy.duration))) {
        return finalizationPendingResponse(finalizationCapability)
      }
      if (banPolicy && !(await verifyAuthBanState(userId, true, banPolicy.minimumBannedUntil))) {
        return finalizationPendingResponse(finalizationCapability)
      }
      if (billingTargetError) {
        logger.error('Failed to resolve durable recovery billing compensation target', {
          userId,
          operationId,
          error:
            billingTargetError instanceof Error
              ? billingTargetError.message
              : String(billingTargetError),
        })
        return finalizationPendingResponse(finalizationCapability)
      }
      if (scope === 'billing_stop_required') {
        try {
          if (!billingTarget) {
            throw new Error('Recovery billing compensation target was not resolved')
          }
          if (billingTarget.b2cTarget) {
            if (!billingTarget.stripeCustomerId) {
              throw new Error('Exact B2C compensation target has no durable Stripe customer')
            }
            await stopExactRecoveredB2CBillingForCompensation(userId, {
              subscriptionId: billingTarget.b2cTarget.stripeSubscriptionId,
              customerId: billingTarget.stripeCustomerId,
              livemode: billingTarget.livemode,
            })
          } else {
            // A null target is safe only because the immutable snapshot proves
            // that this recovery attempt had no B2C Subscription to mutate.
            assertCurrentStripeMode(billingTarget.livemode)
          }
        } catch (error) {
          logger.error('Failed to stop exact billing after recovery Auth re-ban', {
            userId,
            operationId,
            targetDigest: billingTarget?.targetDigest,
            error: error instanceof Error ? error.message : String(error),
          })
          return finalizationPendingResponse(finalizationCapability)
        }
      }
      try {
        if (
          (await completeAuthCompensation({
            userId,
            operationId,
            capabilityHash,
            attemptId,
          })) !== 'compensated'
        ) {
          return finalizationPendingResponse(finalizationCapability)
        }
      } catch (error) {
        logger.error('Recovery Auth compensation acknowledgement failed', {
          userId,
          operationId,
          error: error instanceof Error ? error.message : String(error),
        })
        return finalizationPendingResponse(finalizationCapability)
      }
      return finalizationPendingResponse(finalizationCapability)
    }
    if (authClaimAck === 'compensation_auth_only') return compensateModerationBan('auth_only')
    if (authClaimAck === 'compensation_billing') {
      return compensateModerationBan('billing_stop_required')
    }
    if (authClaimAck === 'invalid') {
      return clearFinalizationCookie(
        NextResponse.json(
          { success: false, code: 'capability_invalid', error: INVALID_RECOVERY },
          { status: 410 }
        ),
        operationId
      )
    }

    if (authClaimAck === 'completed_resumed' || authClaimAck === 'completed_manual') {
      let replay: RecoveryBillingCompletion
      try {
        replay = await readRecoveryBillingResult({ userId, operationId, capabilityHash })
      } catch (error) {
        logger.error('Recovery billing replay result was unavailable', {
          userId,
          operationId,
          error: error instanceof Error ? error.message : String(error),
        })
        return finalizationPendingResponse(finalizationCapability)
      }
      if (replay.status !== authClaimAck) {
        logger.error('Recovery billing replay result conflicted with admission state', {
          userId,
          operationId,
          admissionStatus: authClaimAck,
          billingStatus: replay.status,
        })
        return finalizationPendingResponse(finalizationCapability)
      }
      return clearSuccessfulRecoveryCredentials(
        NextResponse.json({
          success: true,
          subscription_resumed: replay.subscriptionResumed,
          billing_reactivation_required: replay.billingReactivationRequired,
          message: replay.billingReactivationRequired
            ? 'Account and retained data recovered, but billing must be reactivated from account settings.'
            : 'Account and retained data recovered successfully. You can now log in.',
        }),
        finalizationCapability
      )
    }

    // A claimed attempt owns Auth unban. `billing_pending` skips Auth and
    // resumes only the idempotent billing leg after a previous crash.
    if (authClaimAck === 'claimed') {
      const { error: finalUnbanError } = await admin.auth.admin.updateUserById(userId, {
        ban_duration: 'none',
      })
      if (finalUnbanError) {
        try {
          const compensationAck = await requireAuthCompensation({
            userId,
            operationId,
            capabilityHash,
            attemptId,
          })
          if (compensationAck === 'compensation_auth_only') {
            return compensateModerationBan('auth_only')
          }
          if (compensationAck === 'compensation_billing') {
            return compensateModerationBan('billing_stop_required')
          }
        } catch (error) {
          logger.error('Could not durably require Auth compensation', {
            userId,
            operationId,
            error: error instanceof Error ? error.message : String(error),
          })
        }
        return finalizationPendingResponse(finalizationCapability)
      } else {
        if (!(await verifyAuthBanState(userId, false))) {
          try {
            const compensationAck = await requireAuthCompensation({
              userId,
              operationId,
              capabilityHash,
              attemptId,
            })
            if (compensationAck === 'compensation_auth_only') {
              return compensateModerationBan('auth_only')
            }
            if (compensationAck === 'compensation_billing') {
              return compensateModerationBan('billing_stop_required')
            }
          } catch (error) {
            logger.error('Could not compensate an unverified Auth unban', {
              userId,
              operationId,
              error: error instanceof Error ? error.message : String(error),
            })
          }
          return finalizationPendingResponse(finalizationCapability)
        }
        let finalizeAck: AuthFinalizationFinishAck | null = null
        try {
          finalizeAck = await finalizeAuthFinalization({
            userId,
            operationId,
            capabilityHash,
            attemptId,
          })
        } catch (error) {
          logger.error('Recovery Auth finalize acknowledgement failed', {
            userId,
            operationId,
            error: error instanceof Error ? error.message : String(error),
          })
        }
        if (finalizeAck === 'compensation_auth_only') {
          return compensateModerationBan('auth_only')
        }
        if (finalizeAck !== 'finalized' && finalizeAck !== 'already_finalized') {
          return finalizationPendingResponse(finalizationCapability)
        }
      }
    }

    try {
      if (
        (await armRecoveryBilling({ userId, operationId, capabilityHash, attemptId })) !== 'armed'
      ) {
        return finalizationPendingResponse(finalizationCapability)
      }
    } catch (error) {
      logger.error('Recovery billing arm acknowledgement failed', {
        userId,
        operationId,
        error: error instanceof Error ? error.message : String(error),
      })
      return finalizationPendingResponse(finalizationCapability)
    }

    let livemode: boolean
    try {
      livemode = requireStripeLivemode()
    } catch (error) {
      logger.error('Recovery billing mode was unavailable', {
        userId,
        operationId,
        error: error instanceof Error ? error.message : String(error),
      })
      return finalizationPendingResponse(finalizationCapability)
    }

    let targets: RecoveryBillingTargets
    try {
      targets = await resolveRecoveryBillingTargets({
        userId,
        operationId,
        capabilityHash,
        attemptId,
        livemode,
      })
    } catch (error) {
      logger.error('Recovery billing target resolution failed', {
        userId,
        operationId,
        error: error instanceof Error ? error.message : String(error),
      })
      return finalizationPendingResponse(finalizationCapability)
    }

    let billingRecovery: BillingRecoveryState
    try {
      billingRecovery = await resumeSubscription({ userId, livemode, targets })
    } catch (error) {
      logger.error('Exact B2C subscription recovery was uncertain', {
        userId,
        operationId,
        error: error instanceof Error ? error.message : String(error),
      })
      if (error instanceof B2CSubscriptionRecoveryIdentityConflictError) {
        billingRecovery = { targets, observation: null }
      } else if (!(error instanceof B2CSubscriptionRecoveryWriteUncertainError)) {
        return finalizationPendingResponse(finalizationCapability)
      } else {
        const target = targets.b2cTarget
        if (!target) return finalizationPendingResponse(finalizationCapability)
        try {
          if (!targets.stripeCustomerId) {
            return finalizationPendingResponse(finalizationCapability)
          }
          const stopResult = await stopExactRecoveredB2CBillingForCompensation(userId, {
            subscriptionId: target.stripeSubscriptionId,
            customerId: targets.stripeCustomerId,
            livemode,
          })
          if (stopResult.status === 'missing') {
            billingRecovery = {
              targets,
              observation: {
                stripe_subscription_id: target.stripeSubscriptionId,
                missing: true,
              },
            }
          } else {
            // A terminal cancel result never restores authority by itself. A
            // fresh exact recovery read supplies the only completion evidence.
            billingRecovery = await resumeSubscription({ userId, livemode, targets })
          }
        } catch (compensationError) {
          logger.error('Exact B2C recovery compensation remained uncertain', {
            userId,
            operationId,
            error:
              compensationError instanceof Error
                ? compensationError.message
                : String(compensationError),
          })
          return finalizationPendingResponse(finalizationCapability)
        }
      }
    }

    let completion: RecoveryBillingCompletion
    try {
      completion = await completeRecoveryBilling({
        userId,
        operationId,
        capabilityHash,
        attemptId,
        livemode,
        targetDigest: billingRecovery.targets.targetDigest,
        b2cObservation: billingRecovery.observation,
      })
    } catch (error) {
      logger.error('Recovery billing completion acknowledgement failed', {
        userId,
        operationId,
        error: error instanceof Error ? error.message : String(error),
      })
      try {
        const committed = await readRecoveryBillingResult({
          userId,
          operationId,
          capabilityHash,
        })
        if (committed.targetDigest !== billingRecovery.targets.targetDigest) {
          throw new Error('Recovery billing result target digest conflicted')
        }
        completion = committed
      } catch (readError) {
        logger.error('Recovery billing completion could not be proven after transport failure', {
          userId,
          operationId,
          error: readError instanceof Error ? readError.message : String(readError),
        })
        let compensationAck:
          | 'compensation_auth_only'
          | 'compensation_billing'
          | 'completed_resumed'
          | 'completed_manual'
          | 'busy'
          | 'invalid'
        try {
          compensationAck = await requireAuthCompensation({
            userId,
            operationId,
            capabilityHash,
            attemptId,
          })
        } catch (compensationError) {
          logger.error('Recovery completion compensation CAS was unavailable', {
            userId,
            operationId,
            error:
              compensationError instanceof Error
                ? compensationError.message
                : String(compensationError),
          })
          return finalizationPendingResponse(finalizationCapability)
        }
        if (compensationAck === 'compensation_auth_only') {
          return compensateModerationBan('auth_only')
        }
        if (compensationAck === 'compensation_billing') {
          return compensateModerationBan('billing_stop_required')
        }
        if (compensationAck !== 'completed_resumed' && compensationAck !== 'completed_manual') {
          return finalizationPendingResponse(finalizationCapability)
        }
        try {
          const committed = await readRecoveryBillingResult({
            userId,
            operationId,
            capabilityHash,
          })
          if (
            committed.status !== compensationAck ||
            committed.targetDigest !== billingRecovery.targets.targetDigest
          ) {
            throw new Error('Late recovery completion result conflicted')
          }
          completion = committed
        } catch (lateReadError) {
          logger.error('Late recovery completion won but its result was unavailable', {
            userId,
            operationId,
            error: lateReadError instanceof Error ? lateReadError.message : String(lateReadError),
          })
          return finalizationPendingResponse(finalizationCapability)
        }
      }
    }
    if (completion.status === 'compensation_billing') {
      return compensateModerationBan('billing_stop_required')
    }
    if (
      (completion.status === 'completed_resumed') !== completion.subscriptionResumed ||
      (completion.status === 'completed_manual') !== completion.billingReactivationRequired
    ) {
      logger.error('Recovery billing completion state was internally inconsistent', {
        userId,
        operationId,
        status: completion.status,
      })
      return finalizationPendingResponse(finalizationCapability)
    }

    logger.info('Account recovered successfully', { userId })
    return clearSuccessfulRecoveryCredentials(
      NextResponse.json({
        success: true,
        subscription_resumed: completion.subscriptionResumed,
        billing_reactivation_required: completion.billingReactivationRequired,
        message: completion.billingReactivationRequired
          ? 'Account recovered, but one or more billing products must be reactivated from account settings.'
          : 'Account and retained data recovered successfully. You can now log in.',
      }),
      finalizationCapability
    )
  }

  const hasRecoveryToken =
    Object.prototype.hasOwnProperty.call(body, 'recovery_token') || body.recovery_cookie === true
  let recoveryToken: string | null = null
  let selectedFallbackOperationId: string | null = null
  if (hasRecoveryToken) {
    if (body.recovery_cookie === true && !isSameOriginBrowserRequest(request)) {
      return noStore(
        NextResponse.json({ success: false, error: INVALID_RECOVERY }, { status: 401 })
      )
    }
    const fallbackOperationId = isOperationId(body.recovery_cookie_operation_id)
      ? body.recovery_cookie_operation_id
      : null
    selectedFallbackOperationId = body.recovery_cookie ? fallbackOperationId : null
    const suppliedRecoveryToken = body.recovery_cookie
      ? fallbackOperationId
        ? readFallbackRecoveryCookie(request, fallbackOperationId)
        : null
      : body.recovery_token
    if (!isAccountRecoveryToken(suppliedRecoveryToken)) {
      return NextResponse.json({ success: false, error: INVALID_RECOVERY }, { status: 401 })
    }
    recoveryToken = suppliedRecoveryToken
  }

  let normalizedEmail: string | null = null
  let recoveryPassword: string | null = null
  if (!recoveryToken) {
    const { email, password } = body
    if (
      typeof email !== 'string' ||
      typeof password !== 'string' ||
      email.trim().length < 3 ||
      email.trim().length > 320 ||
      Buffer.byteLength(password, 'utf8') < 1 ||
      Buffer.byteLength(password, 'utf8') > 72
    ) {
      return badRequest('Email and password are required')
    }
    normalizedEmail = email.trim().toLowerCase()
    recoveryPassword = password
    body.email = normalizedEmail
  }

  const recoveryTokenHash = recoveryToken
    ? createHash('sha256').update(recoveryToken).digest('hex')
    : null
  let reacquisition: RecoveryReacquisitionLocator
  try {
    reacquisition = await locateRecoveryReacquisition({
      recoveryTokenHash,
      email: normalizedEmail,
      password: recoveryPassword,
    })
  } catch (error) {
    logger.error('Recovery capability reacquisition locator was unavailable', {
      requestedOperationId,
      error: error instanceof Error ? error.message : String(error),
    })
    return noStore(
      NextResponse.json(
        { success: false, error: 'Recovery is temporarily unavailable. Please try again.' },
        { status: 503 }
      )
    )
  }
  if (reacquisition.status === 'unavailable') {
    return noStore(
      NextResponse.json(
        { success: false, error: 'Recovery is temporarily unavailable. Please try again.' },
        { status: 503 }
      )
    )
  }
  if (reacquisition.status === 'invalid') {
    return noStore(NextResponse.json({ success: false, error: INVALID_RECOVERY }, { status: 401 }))
  }
  if (reacquisition.status === 'located') {
    if (!finalizationSecrets) {
      return noStore(
        NextResponse.json(
          { success: false, error: 'Recovery is temporarily unavailable. Please try again.' },
          { status: 503 }
        )
      )
    }
    const capabilityCandidates = deriveFinalizationCapabilityCandidates(
      reacquisition.userId,
      reacquisition.operationId,
      finalizationSecrets
    )
    const capabilityHashes = capabilityCandidates.map(hashFinalizationCapability)
    let attestation: RecoveryReacquisitionAttestation
    try {
      attestation = await attestRecoveryReacquisition({
        reacquisitionId: reacquisition.reacquisitionId,
        reacquisitionProof: reacquisition.reacquisitionProof,
        currentCapabilityHash: capabilityHashes[0],
        previousCapabilityHash: capabilityHashes[1] ?? null,
      })
    } catch (error) {
      logger.error('Recovery capability reacquisition attestation was unavailable', {
        requestedOperationId,
        recoveryOperationId: reacquisition.operationId,
        error: error instanceof Error ? error.message : String(error),
      })
      return noStore(
        NextResponse.json(
          { success: false, error: 'Recovery is temporarily unavailable. Please try again.' },
          { status: 503 }
        )
      )
    }
    if (attestation.status === 'invalid') {
      return noStore(
        NextResponse.json({ success: false, error: INVALID_RECOVERY }, { status: 401 })
      )
    }
    const capability = capabilityCandidates[attestation.candidateIndex]
    if (
      attestation.userId !== reacquisition.userId ||
      attestation.operationId !== reacquisition.operationId ||
      !capability
    ) {
      logger.error('Recovery capability reacquisition acknowledgement conflicted', {
        requestedOperationId,
        locatedUserId: reacquisition.userId,
        locatedOperationId: reacquisition.operationId,
        attestedUserId: attestation.userId,
        attestedOperationId: attestation.operationId,
        candidateIndex: attestation.candidateIndex,
      })
      return noStore(
        NextResponse.json(
          { success: false, error: 'Recovery is temporarily unavailable. Please try again.' },
          { status: 503 }
        )
      )
    }
    return finalizationPreparedResponse({
      userId: reacquisition.userId,
      operationId: reacquisition.operationId,
      capability,
      fallbackOperationId: selectedFallbackOperationId,
    })
  }

  let userId: string | null = null
  if (recoveryToken) {
    const { data: tokenRow, error } = await admin
      .from('account_recovery_tokens')
      .select('user_id, expires_at, used_at')
      .eq('token_hash', recoveryTokenHash!)
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
    const { data: profile, error } = await admin
      .from('user_profiles')
      .select('id, deletion_scheduled_at')
      .eq('email', normalizedEmail!)
      .not('deleted_at', 'is', null)
      .maybeSingle()
    if (error) {
      return NextResponse.json(
        { success: false, error: 'Recovery is temporarily unavailable. Please try again.' },
        { status: 503 }
      )
    }
    if (!profile) {
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
  if (!finalizationSecrets) {
    return noStore(
      NextResponse.json(
        { success: false, error: 'Recovery is temporarily unavailable. Please try again.' },
        { status: 503 }
      )
    )
  }

  const operationId = requestedOperationId!
  const [capability] = deriveFinalizationCapabilityCandidates(
    userId,
    operationId,
    finalizationSecrets
  )
  const capabilityHash = hashFinalizationCapability(capability)
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
    return noStore(
      NextResponse.json(
        { success: false, error: 'Recovery is temporarily unavailable. Please try again.' },
        { status: 503 }
      )
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

  if (!recoveryTokenHash) {
    try {
      const verifyAck = await verifyRecoveryPassword({
        userId,
        operationId,
        email: body.email!,
        password: body.password!,
      })
      if (verifyAck === 'unavailable') {
        await abortRecoveryAdmissionBestEffort({ userId, operationId })
        return noStore(
          NextResponse.json(
            { success: false, error: 'Recovery is temporarily unavailable. Please try again.' },
            { status: 503 }
          )
        )
      }
      if (verifyAck !== 'verified') {
        await abortRecoveryAdmissionBestEffort({ userId, operationId })
        return NextResponse.json({ success: false, error: INVALID_RECOVERY }, { status: 401 })
      }
    } catch (error) {
      logger.error('Pending account password verification failed', {
        userId,
        operationId,
        error: error instanceof Error ? error.message : String(error),
      })
      await abortRecoveryAdmissionBestEffort({ userId, operationId })
      return NextResponse.json(
        { success: false, error: 'Recovery is temporarily unavailable. Please try again.' },
        { status: 503 }
      )
    }
  }

  try {
    const prepareAck = await prepareRecoveryFinalization({
      userId,
      operationId,
      capabilityHash,
    })
    if (prepareAck !== 'prepared') {
      await abortRecoveryAdmissionBestEffort({ userId, operationId })
      return NextResponse.json({ success: false, error: INVALID_RECOVERY }, { status: 401 })
    }
  } catch (error) {
    // Do not abort an ambiguous prepare: PostgreSQL may have committed the
    // capability. No restore/token consumption has happened, and the lease
    // can safely expire without leaving an active account.
    logger.error('Failed to prepare recoverable account recovery commit', {
      userId,
      operationId,
      error: error instanceof Error ? error.message : String(error),
    })
    return finalizationPendingResponse({
      userId,
      operationId,
      capability,
      fallbackOperationId: selectedFallbackOperationId,
    })
  }

  return finalizationPreparedResponse({
    userId,
    operationId,
    capability,
    fallbackOperationId: selectedFallbackOperationId,
  })
}

const recoveryPost = withPublic(recoveryHandler, {
  name: 'account-recover',
  rateLimit: 'sensitive',
  skipCsrf: true,
})
const recoveryStatusPost = withPublic(recoveryHandler, {
  name: 'account-recover-status',
  rateLimit: {
    requests: 60,
    window: 60,
    prefix: 'account-recover-status',
    failClose: true,
  },
  skipCsrf: true,
})

export async function POST(request: Request): Promise<Response> {
  const phase = new URL(request.url).searchParams.get('phase')
  const response = await (phase === 'status' || phase === 'fallback-status'
    ? recoveryStatusPost(request as never)
    : recoveryPost(request as never))
  response.headers.set('Cache-Control', 'private, no-store, max-age=0')
  return response
}
