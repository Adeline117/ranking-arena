import { NextRequest, NextResponse } from 'next/server'
import { getAuthUser, getSupabaseAdmin } from '@/lib/supabase/server'
import { createLogger } from '@/lib/utils/logger'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'

const logger = createLogger('referral-apply')

const REFERRAL_REWARD_THRESHOLD = 3
const PRO_EXTENSION_DAYS = 30

/**
 * POST /api/referral/apply
 * Apply a referral code during/after signup.
 * - Sets `referred_by` on the current user's profile
 * - Increments the referrer's referral count (via query)
 * - If referrer reaches 3 referrals, extend their Pro subscription by 1 month
 */
export async function POST(req: NextRequest) {
  try {
    const rateLimitResult = await checkRateLimit(req, RateLimitPresets.authenticated)
    if (rateLimitResult) return rateLimitResult

    const user = await getAuthUser(req)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await req.json().catch(() => null)
    const code = body?.code?.trim()

    if (!code || typeof code !== 'string' || code.length < 2) {
      return NextResponse.json({ error: 'Invalid referral code' }, { status: 400 })
    }

    const supabase = getSupabaseAdmin()

    // Check if user already has a referrer
    const { data: currentProfile } = await supabase
      .from('user_profiles')
      .select('referred_by')
      .eq('id', user.id)
      .maybeSingle()

    if (currentProfile?.referred_by) {
      return NextResponse.json({ error: 'Referral code already applied' }, { status: 400 })
    }

    // Find the referrer by referral_code or handle
    const { data: referrer } = await supabase
      .from('user_profiles')
      .select('id, referral_code, handle')
      .or(`referral_code.eq.${code},handle.eq.${code}`)
      .limit(1)
      .maybeSingle()

    if (!referrer) {
      return NextResponse.json({ error: 'Referral code not found' }, { status: 404 })
    }

    // Cannot refer yourself
    if (referrer.id === user.id) {
      return NextResponse.json({ error: 'Cannot use your own referral code' }, { status: 400 })
    }

    // Set referred_by on the current user
    const { error: updateError } = await supabase
      .from('user_profiles')
      .update({ referred_by: referrer.id })
      .eq('id', user.id)

    if (updateError) {
      logger.error('Failed to set referred_by:', updateError.message)
      return NextResponse.json({ error: 'Failed to apply referral code' }, { status: 500 })
    }

    // Count total referrals for the referrer (including this new one)
    const { count: referralCount } = await supabase
      .from('user_profiles')
      .select('id', { count: 'exact', head: true })
      .eq('referred_by', referrer.id)

    const totalReferrals = referralCount ?? 0

    // Check if referrer just hit the reward threshold
    if (totalReferrals === REFERRAL_REWARD_THRESHOLD) {
      await grantProExtension(supabase, referrer.id)
      logger.info(`Referrer ${referrer.id} reached ${REFERRAL_REWARD_THRESHOLD} referrals — granted ${PRO_EXTENSION_DAYS}-day Pro extension`)
    }

    return NextResponse.json({
      success: true,
      referrer_handle: referrer.handle,
      referral_count: totalReferrals,
      reward_earned: totalReferrals >= REFERRAL_REWARD_THRESHOLD,
    })
  } catch (error) {
    logger.error('Referral apply error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

/**
 * Grant or extend Pro subscription by PRO_EXTENSION_DAYS for the referrer.
 */
async function grantProExtension(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  userId: string,
) {
  try {
    // Check if user already has an active subscription
    const { data: existingSub } = await supabase
      .from('subscriptions')
      .select('id, current_period_end, status')
      .eq('user_id', userId)
      .in('status', ['active', 'trialing'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    const now = new Date()

    if (existingSub) {
      // Extend existing subscription
      const currentEnd = existingSub.current_period_end
        ? new Date(existingSub.current_period_end)
        : now
      const newEnd = new Date(Math.max(currentEnd.getTime(), now.getTime()))
      newEnd.setDate(newEnd.getDate() + PRO_EXTENSION_DAYS)

      await supabase
        .from('subscriptions')
        .update({ current_period_end: newEnd.toISOString() })
        .eq('id', existingSub.id)
    } else {
      // Create a new referral-based subscription
      const endDate = new Date(now)
      endDate.setDate(endDate.getDate() + PRO_EXTENSION_DAYS)

      await supabase.from('subscriptions').insert({
        user_id: userId,
        tier: 'pro',
        status: 'active',
        plan: 'referral_reward',
        current_period_start: now.toISOString(),
        current_period_end: endDate.toISOString(),
      })

      // Also update user_profiles
      await supabase
        .from('user_profiles')
        .update({ subscription_tier: 'pro', is_pro: true })
        .eq('id', userId)
    }

    // Send notification to referrer
    await supabase.from('notifications').insert({
      user_id: userId,
      type: 'referral_reward',
      title: 'Referral reward earned!',
      message: `You referred ${REFERRAL_REWARD_THRESHOLD} friends and earned ${PRO_EXTENSION_DAYS} days of Pro! Thank you for spreading the word.`,
      link: '/settings',
    })
  } catch (err) {
    logger.error('Failed to grant Pro extension:', err)
  }
}
