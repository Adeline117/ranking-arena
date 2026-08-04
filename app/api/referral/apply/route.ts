import { NextResponse } from 'next/server'
import { createHash } from 'crypto'
import { z } from 'zod'
import { withAuth } from '@/lib/api/middleware'
import { createLogger } from '@/lib/utils/logger'
import { getIdentifier } from '@/lib/utils/rate-limit'

const logger = createLogger('referral-apply')
const NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
} as const
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export const dynamic = 'force-dynamic'

const referralCodeSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_-]{2,64}$/)
const applyReferralBodySchema = z.object({ code: referralCodeSchema }).strict()

type ReferralErrorCode =
  | 'REFERRAL_INVALID_CODE'
  | 'REFERRAL_CODE_NOT_FOUND'
  | 'REFERRAL_CODE_AMBIGUOUS'
  | 'REFERRAL_SELF_REFERRAL'
  | 'REFERRAL_ALREADY_ATTRIBUTED'
  | 'REFERRAL_AUTHORITY_UNAVAILABLE'

function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE_HEADERS })
}

function referralError(code: ReferralErrorCode, error: string, status: number): NextResponse {
  return json({ success: false, code, error }, status)
}

type ReferralAttributionAck =
  | {
      status: 'applied' | 'already_applied'
      referredId: string
      referrerId: string
      attributionId: string
      created: boolean
    }
  | { status: 'conflict' | 'not_found' | 'invalid' | 'inconsistent' }

function exactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(record).sort()
  return actual.length === expected.length && expected.every((key, index) => actual[index] === key)
}

function parseAttributionAck(value: unknown): ReferralAttributionAck | null {
  if (!value || Array.isArray(value) || typeof value !== 'object') return null
  const result = value as Record<string, unknown>

  if (
    exactKeys(result, ['status']) &&
    ['conflict', 'not_found', 'invalid', 'inconsistent'].includes(String(result.status))
  ) {
    return {
      status: result.status as 'conflict' | 'not_found' | 'invalid' | 'inconsistent',
    }
  }

  if (
    !exactKeys(result, ['attribution_id', 'created', 'referred_id', 'referrer_id', 'status']) ||
    (result.status !== 'applied' && result.status !== 'already_applied') ||
    typeof result.referred_id !== 'string' ||
    typeof result.referrer_id !== 'string' ||
    typeof result.attribution_id !== 'string' ||
    !UUID_PATTERN.test(result.referred_id) ||
    !UUID_PATTERN.test(result.referrer_id) ||
    !UUID_PATTERN.test(result.attribution_id) ||
    typeof result.created !== 'boolean' ||
    (result.status === 'applied' && result.created !== true) ||
    (result.status === 'already_applied' && result.created !== false)
  ) {
    return null
  }

  return {
    status: result.status,
    referredId: result.referred_id,
    referrerId: result.referrer_id,
    attributionId: result.attribution_id,
    created: result.created,
  }
}

/**
 * POST /api/referral/apply
 * Attribute a referral code during/after signup. Attribution only — NO rewards
 * are granted here (deferred qualification):
 * - Atomically sets `referred_by` and records the referral_attributions row.
 * - An exact retry repairs historical half-writes and returns idempotent success.
 * - The qualify-referrals cron later grants the friend trial + counts the
 *   advocate threshold, but ONLY for accounts that cross the activity bar — so
 *   throwaway/farm accounts never earn rewards. See lib/referral/grant.ts.
 */
export const POST = withAuth(
  async ({ user, supabase, request }) => {
    let body: unknown
    try {
      body = await request.json()
    } catch {
      body = null
    }

    const parsedBody = applyReferralBodySchema.safeParse(body)
    if (!parsedBody.success) {
      return referralError('REFERRAL_INVALID_CODE', 'Invalid referral code', 400)
    }
    const code = parsedBody.data.code
    const referredId = typeof user.id === 'string' ? user.id : ''
    if (!UUID_PATTERN.test(referredId)) {
      logger.error('Authenticated referral actor has a malformed identity')
      return referralError('REFERRAL_AUTHORITY_UNAVAILABLE', 'Failed to apply referral code', 500)
    }

    // Find the referrer by referral_code or handle
    const { data: referrers, error: referrerErr } = await supabase
      .from('user_profiles')
      .select('id, referral_code, handle')
      // Safe: `code` is validated against ^[A-Za-z0-9_-]{2,64}$ above, so it
      // contains no PostgREST filter metacharacters.
      .or(`referral_code.eq.${code},handle.eq.${code}`)
      // referral_code and handle have separate uniqueness constraints. Fetch
      // two so a cross-namespace collision fails closed instead of crediting an
      // arbitrary referrer.
      .limit(2)
    if (referrerErr) {
      // Don't misclassify a DB fault as "code not found".
      logger.error('Failed to look up referrer:', referrerErr.message)
      return referralError('REFERRAL_AUTHORITY_UNAVAILABLE', 'Failed to apply referral code', 503)
    }

    if (!Array.isArray(referrers)) {
      logger.error('Referral lookup returned a null or non-array result')
      return referralError('REFERRAL_AUTHORITY_UNAVAILABLE', 'Failed to apply referral code', 500)
    }
    if (referrers.length === 0) {
      return referralError('REFERRAL_CODE_NOT_FOUND', 'Referral code not found', 404)
    }
    if (referrers.length !== 1) {
      logger.error('Referral code matched multiple profile identities', { code })
      return referralError('REFERRAL_CODE_AMBIGUOUS', 'Referral code is ambiguous', 409)
    }
    const referrer = referrers[0]
    if (
      !referrer ||
      typeof referrer.id !== 'string' ||
      !UUID_PATTERN.test(referrer.id) ||
      typeof referrer.handle !== 'string' ||
      referrer.handle.length < 1 ||
      Array.from(referrer.handle).length > 64 ||
      referrer.handle !== referrer.handle.trim() ||
      referrer.handle !== referrer.handle.normalize('NFC') ||
      CONTROL_PATTERN.test(referrer.handle) ||
      (referrer.referral_code !== null &&
        (typeof referrer.referral_code !== 'string' ||
          !/^[A-Za-z0-9_-]{2,64}$/.test(referrer.referral_code))) ||
      (referrer.referral_code !== code && referrer.handle !== code)
    ) {
      logger.error('Referral lookup returned a malformed profile identity', { code })
      return referralError('REFERRAL_AUTHORITY_UNAVAILABLE', 'Failed to apply referral code', 500)
    }
    const referrerId = referrer.id

    // Cannot refer yourself
    if (referrerId === referredId) {
      return referralError('REFERRAL_SELF_REFERRAL', 'Cannot use your own referral code', 400)
    }

    // Anti-farming: record this attribution with a hashed device fingerprint
    // (IP+UA bucket → sha256; no raw IP/PII stored). getIdentifier(request) with
    // no userId returns the per-device bucket the rate limiter uses.
    const deviceBucket = getIdentifier(request as Parameters<typeof getIdentifier>[0])
    const signupIpHash =
      deviceBucket === 'ip:unknown'
        ? null
        : createHash('sha256').update(deviceBucket).digest('hex').slice(0, 32)

    const rawProvider = user.app_metadata?.provider
    const provider =
      typeof rawProvider === 'string' &&
      rawProvider.length >= 1 &&
      rawProvider.length <= 100 &&
      rawProvider.trim() === rawProvider &&
      !/[\u0000-\u001f\u007f]/.test(rawProvider)
        ? rawProvider
        : null

    // DEFERRED QUALIFICATION: the edge and attribution are one database
    // transaction. An insert/update fault rolls both back, while an exact retry
    // heals either historical half-write instead of consuming the reward.
    const { data: rawAck, error: attributionError } = await supabase.rpc(
      'apply_referral_attribution_atomic',
      {
        p_referred_id: referredId,
        p_referrer_id: referrerId,
        p_provider: provider,
        p_signup_ip_hash: signupIpHash,
      }
    )
    const ack = parseAttributionAck(rawAck)
    if (attributionError || !ack) {
      logger.error('Atomic referral attribution failed', {
        code: attributionError?.code,
        referredId,
        referrerId,
      })
      return referralError('REFERRAL_AUTHORITY_UNAVAILABLE', 'Failed to apply referral code', 500)
    }
    if (ack.status === 'conflict') {
      return referralError('REFERRAL_ALREADY_ATTRIBUTED', 'Referral code already applied', 409)
    }
    if (ack.status === 'not_found') {
      // The lookup already proved the code existed. Here `not_found` can mean
      // the newly authenticated user's profile is not provisioned yet, so it
      // is retryable and must not consume the pending code.
      return referralError('REFERRAL_AUTHORITY_UNAVAILABLE', 'Failed to apply referral code', 503)
    }
    if (ack.status === 'invalid' || ack.status === 'inconsistent') {
      logger.error('Atomic referral attribution rejected server-owned identity', {
        referredId,
        referrerId,
        status: ack.status,
      })
      return referralError('REFERRAL_AUTHORITY_UNAVAILABLE', 'Failed to apply referral code', 500)
    }
    if (ack.status !== 'applied' && ack.status !== 'already_applied') {
      logger.error('Atomic referral attribution returned an unhandled status', {
        referredId,
        referrerId,
      })
      return referralError('REFERRAL_AUTHORITY_UNAVAILABLE', 'Failed to apply referral code', 500)
    }
    if (
      ack.referredId !== user.id ||
      ack.referrerId !== referrer.id ||
      !UUID_PATTERN.test(ack.attributionId)
    ) {
      logger.error('Atomic referral attribution ACK contradicted the request', {
        attributionId: ack.attributionId,
        referredId,
        referrerId,
      })
      return referralError('REFERRAL_AUTHORITY_UNAVAILABLE', 'Failed to apply referral code', 500)
    }

    return json({
      success: true,
      status: ack.status,
      referred_id: referredId,
      referrer_id: referrerId,
      attribution_id: ack.attributionId,
      created: ack.created,
      code,
      referrer_handle: referrer.handle,
    })
  },
  { name: 'referral/apply', rateLimit: 'write' }
)
