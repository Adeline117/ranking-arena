import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/api/middleware'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { createLogger } from '@/lib/utils/logger'
import { sendNotification } from '@/lib/data/notifications'
import {
  REFERRAL_REWARD_THRESHOLD,
  REFERRAL_ADVOCATE_PRO_DAYS,
  REFERRED_FRIEND_TRIAL_DAYS,
} from '@/lib/constants/referral'

const logger = createLogger('referral-apply')

/**
 * POST /api/referral/apply
 * Apply a referral code during/after signup.
 * - Sets `referred_by` on the current user's profile (single source of truth —
 *   a second apply by the same user is rejected, which is what makes both the
 *   advocate and friend grants idempotent).
 * - Counts the referrer's total referrals.
 * - Friend (double-sided) reward: grants the newly-referred user a Pro trial.
 * - Advocate reward: when the referrer hits REFERRAL_REWARD_THRESHOLD, extends
 *   their Pro subscription by REFERRAL_ADVOCATE_PRO_DAYS.
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

    if (!code || typeof code !== 'string' || code.length < 2) {
      return NextResponse.json({ error: 'Invalid referral code' }, { status: 400 })
    }

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
      .or(
        `referral_code.eq.${code.replace(/[,.()\[\]\\%_]/g, '')},handle.eq.${code.replace(/[,.()\[\]\\%_]/g, '')}`
      )
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
    // KEEP 'exact' — drives the REFERRAL_REWARD_THRESHOLD Pro-extension
    // grant. Must be accurate to fire the reward on the exact Nth
    // referral and not double-grant.
    const { count: referralCount } = await supabase
      .from('user_profiles')
      .select('id', { count: 'exact', head: true })
      .eq('referred_by', referrer.id)

    const totalReferrals = referralCount ?? 0

    // Friend-side (double-sided) reward — grant the newly-referred user a Pro
    // trial. IDEMPOTENT: this only runs after referred_by was *just* set above;
    // a second apply by the same user is rejected ("already applied"), so a
    // friend can be granted at most once. Disabled when the constant is 0.
    if (REFERRED_FRIEND_TRIAL_DAYS > 0) {
      await grantProDays(supabase, user.id, REFERRED_FRIEND_TRIAL_DAYS, {
        title: 'Welcome — Pro trial unlocked!',
        message: `You joined via a referral and earned ${REFERRED_FRIEND_TRIAL_DAYS} days of Arena Pro. Enjoy!`,
      })
    }

    // Advocate reward — fires only on the EXACT Nth referral. Each distinct
    // friend increments the count by 1 (referred_by is set once per friend),
    // so under serial signups this grants at most once. See route header / the
    // report for the concurrency caveat (no persistent idempotency marker).
    if (totalReferrals === REFERRAL_REWARD_THRESHOLD) {
      await grantProDays(supabase, referrer.id, REFERRAL_ADVOCATE_PRO_DAYS, {
        title: 'Referral reward earned!',
        message: `You referred ${REFERRAL_REWARD_THRESHOLD} friends and earned ${REFERRAL_ADVOCATE_PRO_DAYS} days of Pro! Thank you for spreading the word.`,
      })
      logger.info(
        `Referrer ${referrer.id} reached ${REFERRAL_REWARD_THRESHOLD} referrals — granted ${REFERRAL_ADVOCATE_PRO_DAYS}-day Pro extension`
      )
    }

    return NextResponse.json({
      success: true,
      referrer_handle: referrer.handle,
      referral_count: totalReferrals,
      reward_earned: totalReferrals >= REFERRAL_REWARD_THRESHOLD,
      friend_reward_days: REFERRED_FRIEND_TRIAL_DAYS,
    })
  },
  { name: 'referral/apply', rateLimit: 'write' }
)

/**
 * Grant or extend a Pro subscription by `days` for the given user, then notify
 * them. Best-effort: DB errors are logged (never silently swallowed) but never
 * thrown, so a grant failure can't break the apply response.
 *
 * NOTE: the `subscriptions` table has no `plan`/source column in prod, so we
 * cannot persist a referral marker here (see report — relevant for advocate
 * idempotency at scale).
 */
async function grantProDays(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  userId: string,
  days: number,
  notification: { title: string; message: string }
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
      // Extend existing subscription from the later of (now, current end)
      const currentEnd = existingSub.current_period_end
        ? new Date(existingSub.current_period_end)
        : now
      const newEnd = new Date(Math.max(currentEnd.getTime(), now.getTime()))
      newEnd.setDate(newEnd.getDate() + days)

      const { error: updateError } = await supabase
        .from('subscriptions')
        .update({ current_period_end: newEnd.toISOString() })
        .eq('id', existingSub.id)
      if (updateError) {
        logger.error('Failed to extend subscription:', updateError.message)
        return
      }
    } else {
      // Create a new referral-based subscription
      const endDate = new Date(now)
      endDate.setDate(endDate.getDate() + days)

      const { error: insertError } = await supabase.from('subscriptions').insert({
        user_id: userId,
        tier: 'pro',
        status: 'active',
        current_period_start: now.toISOString(),
        current_period_end: endDate.toISOString(),
      })
      if (insertError) {
        logger.error('Failed to create referral subscription:', insertError.message)
        return
      }

      // Also flip the profile Pro flags so the UI unlocks immediately
      const { error: profileError } = await supabase
        .from('user_profiles')
        .update({ subscription_tier: 'pro', is_pro: true })
        .eq('id', userId)
      if (profileError) {
        logger.error('Failed to update profile Pro flags:', profileError.message)
      }
    }

    // Notify the recipient
    sendNotification(
      supabase,
      {
        user_id: userId,
        type: 'referral_reward',
        title: notification.title,
        message: notification.message,
        link: '/settings',
      },
      'Referral reward notification'
    )
  } catch (err) {
    logger.error('Failed to grant Pro days:', err)
  }
}
