/**
 * GET /api/cron/qualify-referrals
 *
 * Deferred referral qualification. /api/referral/apply only records attribution;
 * this cron grants the actual rewards, but ONLY for referred accounts that have
 * crossed a real-activity bar — so throwaway/farm accounts never earn Pro.
 *
 * Qualification bar (per referred account):
 *   onboarding_completed = true AND (linked a trader OR account age ≥ N hours)
 *
 * On qualification: mark qualified_at, grant the friend trial (capped per device
 * fingerprint), then grant the advocate reward once the referrer has ≥ threshold
 * QUALIFIED distinct-device referrals (exactly-once via the referral_rewards marker).
 *
 * Schedule: every 6h (Vercel cron sends GET with CRON_SECRET).
 */

import { NextRequest, NextResponse } from 'next/server'
import { logger } from '@/lib/logger'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { PipelineLogger } from '@/lib/services/pipeline-logger'
import { verifyCronSecret } from '@/lib/auth/verify-service-auth'
import { acquireCronLock } from '@/lib/cron/with-cron-lock'
import { grantProDays } from '@/lib/referral/grant'
import {
  REFERRAL_REWARD_THRESHOLD,
  REFERRAL_ADVOCATE_PRO_DAYS,
  REFERRED_FRIEND_TRIAL_DAYS,
  REFERRAL_FRIEND_GRANTS_PER_DEVICE,
  REFERRAL_QUALIFY_MIN_AGE_HOURS,
  REFERRAL_VELOCITY_ALERT_MINUTES,
} from '@/lib/constants/referral'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(request: NextRequest) {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const releaseLock = await acquireCronLock('qualify-referrals', { ttlSeconds: 300 })
  if (!releaseLock) {
    return NextResponse.json({ status: 'skipped', reason: 'already running' })
  }

  const plog = await PipelineLogger.start('qualify-referrals')
  try {
    const supabase = getSupabaseAdmin()

    // Pending (unqualified) attributions, oldest first.
    const { data: pending, error } = await supabase
      .from('referral_attributions')
      .select('id, referred_id, referrer_id, signup_ip_hash, friend_granted')
      .is('qualified_at', null)
      .order('created_at', { ascending: true })
      .limit(500)
    if (error) throw error

    if (!pending?.length) {
      await plog.success(0)
      return NextResponse.json({ status: 'ok', qualified: 0 })
    }

    // Batch-fetch the referred accounts' activity signals.
    const referredIds = pending.map((p) => p.referred_id)
    const { data: profiles } = await supabase
      .from('user_profiles')
      .select('id, onboarding_completed, linked_trader_count, created_at')
      .in('id', referredIds)
    const profileById = new Map((profiles ?? []).map((p) => [p.id, p]))

    const nowMs = Date.now()
    const minAgeMs = REFERRAL_QUALIFY_MIN_AGE_HOURS * 3600_000
    let qualifiedCount = 0
    let friendGrants = 0
    let advocateGrants = 0

    for (const attr of pending) {
      const prof = profileById.get(attr.referred_id)
      if (!prof) continue
      const ageMs = prof.created_at ? nowMs - new Date(prof.created_at).getTime() : 0
      const qualifies =
        prof.onboarding_completed === true &&
        ((prof.linked_trader_count ?? 0) > 0 || ageMs >= minAgeMs)
      if (!qualifies) continue

      // Mark qualified first so the advocate distinct-device count below sees it.
      const { error: qErr } = await supabase
        .from('referral_attributions')
        .update({ qualified_at: new Date().toISOString() })
        .eq('id', attr.id)
        .is('qualified_at', null)
      if (qErr) {
        logger.error('[qualify-referrals] mark qualified failed:', qErr.message)
        continue
      }
      qualifiedCount++

      // Friend trial — capped per device fingerprint across all referrers.
      if (REFERRED_FRIEND_TRIAL_DAYS > 0 && !attr.friend_granted) {
        let deviceAllows = true
        if (attr.signup_ip_hash) {
          const { count } = await supabase
            .from('referral_attributions')
            .select('id', { count: 'exact', head: true })
            .eq('signup_ip_hash', attr.signup_ip_hash)
            .eq('friend_granted', true)
          deviceAllows = (count ?? 0) < REFERRAL_FRIEND_GRANTS_PER_DEVICE
        }
        if (deviceAllows) {
          await grantProDays(supabase, attr.referred_id, REFERRED_FRIEND_TRIAL_DAYS, {
            title: 'Welcome — Pro trial unlocked!',
            message: `You joined via a referral and earned ${REFERRED_FRIEND_TRIAL_DAYS} days of Arena Pro. Enjoy!`,
          })
          await supabase
            .from('referral_attributions')
            .update({ friend_granted: true })
            .eq('id', attr.id)
          friendGrants++
        }
      }

      // Advocate reward — count the referrer's QUALIFIED distinct-device referrals.
      const { data: qualRows } = await supabase
        .from('referral_attributions')
        .select('id, signup_ip_hash, created_at')
        .eq('referrer_id', attr.referrer_id)
        .not('qualified_at', 'is', null)
      const distinct = new Set((qualRows ?? []).map((r) => r.signup_ip_hash ?? `row:${r.id}`))
      if (distinct.size >= REFERRAL_REWARD_THRESHOLD) {
        // Velocity monitoring (log-only): if the qualifying referrals all landed
        // within a tight window, flag for a human look (possible farm the device
        // + activity gates missed). Non-blocking — we still grant.
        const times = (qualRows ?? [])
          .map((r) => (r.created_at ? new Date(r.created_at).getTime() : 0))
          .filter(Boolean)
          .sort((a, b) => a - b)
        if (times.length >= REFERRAL_REWARD_THRESHOLD) {
          const spreadMin = (times[times.length - 1] - times[0]) / 60_000
          if (spreadMin < REFERRAL_VELOCITY_ALERT_MINUTES) {
            logger.warn(
              `[qualify-referrals] VELOCITY FLAG referrer=${attr.referrer_id} — ${times.length} qualified referrals within ${Math.round(spreadMin)}min (threshold ${REFERRAL_VELOCITY_ALERT_MINUTES}min); possible farm, review`
            )
          }
        }
        const { error: markerError } = await supabase.from('referral_rewards').insert({
          referrer_id: attr.referrer_id,
          reward_type: 'advocate_milestone',
          granted_days: REFERRAL_ADVOCATE_PRO_DAYS,
        })
        if (!markerError) {
          await grantProDays(supabase, attr.referrer_id, REFERRAL_ADVOCATE_PRO_DAYS, {
            title: 'Referral reward earned!',
            message: `You referred ${REFERRAL_REWARD_THRESHOLD} friends and earned ${REFERRAL_ADVOCATE_PRO_DAYS} days of Pro! Thank you for spreading the word.`,
          })
          advocateGrants++
        } else if (markerError.code !== '23505') {
          logger.error('[qualify-referrals] advocate marker failed:', markerError.message)
        }
      }
    }

    logger.info(
      `[qualify-referrals] qualified=${qualifiedCount} friendGrants=${friendGrants} advocateGrants=${advocateGrants}`
    )
    await plog.success(qualifiedCount)
    return NextResponse.json({
      status: 'ok',
      qualified: qualifiedCount,
      friendGrants,
      advocateGrants,
    })
  } catch (err) {
    logger.error('[qualify-referrals] failed', err)
    await plog.error(err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  } finally {
    releaseLock()
  }
}
