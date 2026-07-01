import { NextResponse } from 'next/server'
import { createHash } from 'crypto'
import { withAuth } from '@/lib/api/middleware'
import { createLogger } from '@/lib/utils/logger'
import { getIdentifier } from '@/lib/utils/rate-limit'

const logger = createLogger('referral-apply')

/**
 * POST /api/referral/apply
 * Attribute a referral code during/after signup. Attribution only — NO rewards
 * are granted here (deferred qualification):
 * - Sets `referred_by` on the current user via compare-and-swap (single source
 *   of truth; a second apply is rejected).
 * - Records a referral_attributions row (hashed device fingerprint, provider),
 *   with qualified_at = null.
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

    const code = (body?.code as string)?.trim()

    // Strict server-side allowlist (client validation is not a security boundary
    // — a direct API caller bypasses it). referral_code + handle are both drawn
    // from this charset, so this also makes the PostgREST .or() filter below
    // injection-safe without relying on a fragile character blocklist.
    if (!code || typeof code !== 'string' || !/^[A-Za-z0-9_-]{2,64}$/.test(code)) {
      return NextResponse.json({ error: 'Invalid referral code' }, { status: 400 })
    }

    // Check if user already has a referrer
    const { data: currentProfile, error: profileErr } = await supabase
      .from('user_profiles')
      .select('referred_by')
      .eq('id', user.id)
      .maybeSingle()
    if (profileErr) {
      logger.error('Failed to read current profile:', profileErr.message)
      return NextResponse.json({ error: 'Failed to apply referral code' }, { status: 500 })
    }

    if (currentProfile?.referred_by) {
      return NextResponse.json({ error: 'Referral code already applied' }, { status: 400 })
    }

    // Find the referrer by referral_code or handle
    const { data: referrer, error: referrerErr } = await supabase
      .from('user_profiles')
      .select('id, referral_code, handle')
      // Safe: `code` is validated against ^[A-Za-z0-9_-]{2,64}$ above, so it
      // contains no PostgREST filter metacharacters.
      .or(`referral_code.eq.${code},handle.eq.${code}`)
      .limit(1)
      .maybeSingle()
    if (referrerErr) {
      // Don't misclassify a DB fault as "code not found".
      logger.error('Failed to look up referrer:', referrerErr.message)
      return NextResponse.json({ error: 'Failed to apply referral code' }, { status: 500 })
    }

    if (!referrer) {
      return NextResponse.json({ error: 'Referral code not found' }, { status: 404 })
    }

    // Cannot refer yourself
    if (referrer.id === user.id) {
      return NextResponse.json({ error: 'Cannot use your own referral code' }, { status: 400 })
    }

    // Atomically set referred_by ONLY if not already set (compare-and-swap).
    // This is the single guard that makes the FRIEND grant exactly-once: the
    // normal signup path fires this endpoint twice near-simultaneously on the
    // same SIGNED_IN event (LoginPageClient + ReferralAutoApply). Without the
    // `.is('referred_by', null)` predicate both requests would read null, both
    // update, and both grant the friend trial (and, since subscriptions has no
    // unique(user_id), insert duplicate Pro rows). With it, only the request
    // whose update matched a row proceeds; the loser bails as "already applied".
    const { data: updatedRows, error: updateError } = await supabase
      .from('user_profiles')
      .update({ referred_by: referrer.id })
      .eq('id', user.id)
      .is('referred_by', null)
      .select('id')

    if (updateError) {
      logger.error('Failed to set referred_by:', updateError.message)
      return NextResponse.json({ error: 'Failed to apply referral code' }, { status: 500 })
    }

    if (!updatedRows || updatedRows.length === 0) {
      // Lost the CAS race (concurrent apply already set referred_by) → do not
      // grant again.
      return NextResponse.json({ error: 'Referral code already applied' }, { status: 400 })
    }

    // Anti-farming: record this attribution with a hashed device fingerprint
    // (IP+UA bucket → sha256; no raw IP/PII stored). getIdentifier(request) with
    // no userId returns the per-device bucket the rate limiter uses.
    const deviceBucket = getIdentifier(request as Parameters<typeof getIdentifier>[0])
    const signupIpHash =
      deviceBucket === 'ip:unknown'
        ? null
        : createHash('sha256').update(deviceBucket).digest('hex').slice(0, 32)

    // DEFERRED QUALIFICATION: we record attribution now but do NOT grant any
    // reward here. A brand-new account has no activity signal and could be a
    // throwaway/farm account. The qualify-referrals cron later flips qualified_at
    // once the account shows real activity, and only then grants the friend trial
    // + counts toward the advocate threshold. This makes rewards accrue to real
    // users, not farms. referred_id is UNIQUE; ignore a 23505 defensively.
    const { error: attrError } = await supabase.from('referral_attributions').insert({
      referred_id: user.id,
      referrer_id: referrer.id,
      provider: (user.app_metadata?.provider as string | undefined) ?? null,
      signup_ip_hash: signupIpHash,
      friend_granted: false,
    })
    if (attrError && attrError.code !== '23505') {
      logger.error('Failed to write referral attribution:', attrError.message)
    }

    return NextResponse.json({
      success: true,
      referrer_handle: referrer.handle,
      pending: true, // reward is granted later by qualify-referrals once qualified
    })
  },
  { name: 'referral/apply', rateLimit: 'write' }
)
