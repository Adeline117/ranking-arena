import { NextResponse } from 'next/server'
import { createHash } from 'crypto'
import { withAuth } from '@/lib/api/middleware'
import { createLogger } from '@/lib/utils/logger'
import { getIdentifier } from '@/lib/utils/rate-limit'

const logger = createLogger('referral-apply')

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
    let body: Record<string, unknown> | null
    try {
      body = await request.json()
    } catch {
      body = null
    }

    const rawCode = body?.code
    const code = typeof rawCode === 'string' ? rawCode.trim() : ''

    // Strict server-side allowlist (client validation is not a security boundary
    // — a direct API caller bypasses it). referral_code + handle are both drawn
    // from this charset, so this also makes the PostgREST .or() filter below
    // injection-safe without relying on a fragile character blocklist.
    if (!code || !/^[A-Za-z0-9_-]{2,64}$/.test(code)) {
      return NextResponse.json({ error: 'Invalid referral code' }, { status: 400 })
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
      return NextResponse.json({ error: 'Failed to apply referral code' }, { status: 500 })
    }

    if (!Array.isArray(referrers)) {
      logger.error('Referral lookup returned a null or non-array result')
      return NextResponse.json({ error: 'Failed to apply referral code' }, { status: 500 })
    }
    if (referrers.length === 0) {
      return NextResponse.json({ error: 'Referral code not found' }, { status: 404 })
    }
    if (referrers.length !== 1) {
      logger.error('Referral code matched multiple profile identities', { code })
      return NextResponse.json({ error: 'Referral code is ambiguous' }, { status: 409 })
    }
    const referrer = referrers[0]
    if (
      !referrer ||
      typeof referrer.id !== 'string' ||
      (referrer.handle !== null && typeof referrer.handle !== 'string')
    ) {
      logger.error('Referral lookup returned a malformed profile identity', { code })
      return NextResponse.json({ error: 'Failed to apply referral code' }, { status: 500 })
    }

    // Cannot refer yourself
    if (referrer.id === user.id) {
      return NextResponse.json({ error: 'Cannot use your own referral code' }, { status: 400 })
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
        p_referred_id: user.id,
        p_referrer_id: referrer.id,
        p_provider: provider,
        p_signup_ip_hash: signupIpHash,
      }
    )
    const ack = parseAttributionAck(rawAck)
    if (attributionError || !ack) {
      logger.error('Atomic referral attribution failed', {
        code: attributionError?.code,
        referredId: user.id,
        referrerId: referrer.id,
      })
      return NextResponse.json({ error: 'Failed to apply referral code' }, { status: 500 })
    }
    if (ack.status === 'conflict') {
      return NextResponse.json({ error: 'Referral code already applied' }, { status: 400 })
    }
    if (ack.status === 'not_found') {
      return NextResponse.json({ error: 'Referral code not found' }, { status: 404 })
    }
    if (ack.status === 'invalid' || ack.status === 'inconsistent') {
      logger.error('Atomic referral attribution rejected server-owned identity', {
        referredId: user.id,
        referrerId: referrer.id,
        status: ack.status,
      })
      return NextResponse.json({ error: 'Failed to apply referral code' }, { status: 500 })
    }
    if (ack.status !== 'applied' && ack.status !== 'already_applied') {
      logger.error('Atomic referral attribution returned an unhandled status', {
        referredId: user.id,
        referrerId: referrer.id,
      })
      return NextResponse.json({ error: 'Failed to apply referral code' }, { status: 500 })
    }
    if (
      ack.referredId !== user.id ||
      ack.referrerId !== referrer.id ||
      ack.attributionId.length === 0
    ) {
      logger.error('Atomic referral attribution ACK contradicted the request', {
        attributionId: ack.attributionId,
        referredId: user.id,
        referrerId: referrer.id,
      })
      return NextResponse.json({ error: 'Failed to apply referral code' }, { status: 500 })
    }

    return NextResponse.json({
      success: true,
      referrer_handle: referrer.handle,
      pending: true,
    })
  },
  { name: 'referral/apply', rateLimit: 'write' }
)
