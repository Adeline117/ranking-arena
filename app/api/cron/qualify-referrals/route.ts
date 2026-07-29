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
import { sendNotification } from '@/lib/data/notifications'
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

type QualificationCandidate = { id: string }

type QualificationAck =
  | { status: 'not_found' | 'invalid' }
  | {
      status: 'not_eligible' | 'owner_unavailable'
      attributionId: string
    }
  | {
      status: 'qualified' | 'already_qualified'
      attributionId: string
      referredId: string
      referrerId: string
      qualifiedAt: string
      friendStatus: 'granted' | 'already_granted' | 'capped' | 'disabled'
      advocateStatus: 'granted' | 'already_granted' | 'pending'
      advocateRewardId: string | null
      qualifiedReferralCount: number
      qualifiedWindowMinutes: number | null
    }

function exactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(record).sort()
  return actual.length === expected.length && expected.every((key, index) => actual[index] === key)
}

function parseCandidate(value: unknown): QualificationCandidate | null {
  if (!value || Array.isArray(value) || typeof value !== 'object') return null
  const candidate = value as Record<string, unknown>
  if (!exactKeys(candidate, ['id']) || typeof candidate.id !== 'string' || !candidate.id) {
    return null
  }
  return { id: candidate.id }
}

function parseQualificationAck(value: unknown): QualificationAck | null {
  if (!value || Array.isArray(value) || typeof value !== 'object') return null
  const result = value as Record<string, unknown>

  if (
    exactKeys(result, ['status']) &&
    (result.status === 'not_found' || result.status === 'invalid')
  ) {
    return { status: result.status }
  }

  if (
    exactKeys(result, ['attribution_id', 'status']) &&
    (result.status === 'not_eligible' || result.status === 'owner_unavailable') &&
    typeof result.attribution_id === 'string' &&
    result.attribution_id.length > 0
  ) {
    return {
      status: result.status,
      attributionId: result.attribution_id,
    }
  }

  if (
    !exactKeys(result, [
      'advocate_reward_id',
      'advocate_status',
      'attribution_id',
      'friend_status',
      'qualified_at',
      'qualified_referral_count',
      'qualified_window_minutes',
      'referred_id',
      'referrer_id',
      'status',
    ]) ||
    (result.status !== 'qualified' && result.status !== 'already_qualified') ||
    typeof result.attribution_id !== 'string' ||
    !result.attribution_id ||
    typeof result.referred_id !== 'string' ||
    !result.referred_id ||
    typeof result.referrer_id !== 'string' ||
    !result.referrer_id ||
    typeof result.qualified_at !== 'string' ||
    !Number.isFinite(Date.parse(result.qualified_at)) ||
    !['granted', 'already_granted', 'capped', 'disabled'].includes(String(result.friend_status)) ||
    !['granted', 'already_granted', 'pending'].includes(String(result.advocate_status)) ||
    (result.advocate_reward_id !== null && typeof result.advocate_reward_id !== 'string') ||
    ((result.advocate_status === 'granted' || result.advocate_status === 'already_granted') &&
      (typeof result.advocate_reward_id !== 'string' || !result.advocate_reward_id)) ||
    (result.advocate_status === 'pending' && result.advocate_reward_id !== null) ||
    !Number.isSafeInteger(result.qualified_referral_count) ||
    Number(result.qualified_referral_count) < 1 ||
    (result.qualified_window_minutes !== null &&
      (typeof result.qualified_window_minutes !== 'number' ||
        !Number.isFinite(result.qualified_window_minutes) ||
        result.qualified_window_minutes < 0))
  ) {
    return null
  }

  return {
    status: result.status,
    attributionId: result.attribution_id,
    referredId: result.referred_id,
    referrerId: result.referrer_id,
    qualifiedAt: result.qualified_at,
    friendStatus: result.friend_status as 'granted' | 'already_granted' | 'capped' | 'disabled',
    advocateStatus: result.advocate_status as 'granted' | 'already_granted' | 'pending',
    advocateRewardId: result.advocate_reward_id,
    qualifiedReferralCount: Number(result.qualified_referral_count),
    qualifiedWindowMinutes:
      result.qualified_window_minutes === null ? null : Number(result.qualified_window_minutes),
  }
}

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
    const qualificationTime = new Date().toISOString()

    // Include every unfinished outcome, not only unqualified rows. Historical
    // flag-first failures remain eligible until both entitlement outcomes have
    // a durable terminal state. Claiming also rotates the oldest attempt time so
    // 500 permanently ineligible rows cannot starve every newer referral.
    const { data: rawCandidates, error: candidateError } = await supabase.rpc(
      'claim_referral_qualification_candidates_atomic',
      {
        p_now: qualificationTime,
        p_limit: 500,
      }
    )
    if (candidateError) throw candidateError
    if (!Array.isArray(rawCandidates)) {
      throw new Error('Referral qualification candidate query returned no row set')
    }
    const candidates = rawCandidates.map(parseCandidate)
    if (candidates.some((candidate) => candidate === null)) {
      throw new Error('Referral qualification candidate query returned a malformed row')
    }

    if (candidates.length === 0) {
      await plog.success(0)
      return NextResponse.json({
        status: 'ok',
        qualified: 0,
        friendGrants: 0,
        advocateGrants: 0,
        pending: 0,
        skipped: 0,
        failed: 0,
      })
    }

    let qualifiedCount = 0
    let friendGrants = 0
    let advocateGrants = 0
    let pendingCount = 0
    let skippedCount = 0
    let failedCount = 0

    for (const candidate of candidates as QualificationCandidate[]) {
      const { data: rawAck, error: qualificationError } = await supabase.rpc(
        'qualify_referral_attribution_atomic',
        {
          p_attribution_id: candidate.id,
          p_now: qualificationTime,
          p_min_age_hours: REFERRAL_QUALIFY_MIN_AGE_HOURS,
          p_friend_days: REFERRED_FRIEND_TRIAL_DAYS,
          p_device_cap: REFERRAL_FRIEND_GRANTS_PER_DEVICE,
          p_advocate_threshold: REFERRAL_REWARD_THRESHOLD,
          p_advocate_days: REFERRAL_ADVOCATE_PRO_DAYS,
        }
      )
      const ack = parseQualificationAck(rawAck)
      if (
        qualificationError ||
        !ack ||
        ('attributionId' in ack && ack.attributionId !== candidate.id)
      ) {
        failedCount++
        logger.error('[qualify-referrals] atomic qualification failed', {
          attributionId: candidate.id,
          code: qualificationError?.code,
        })
        continue
      }
      if (ack.status === 'invalid') {
        failedCount++
        logger.error('[qualify-referrals] qualification policy was rejected', {
          attributionId: candidate.id,
        })
        continue
      }
      if (ack.status === 'not_found' || ack.status === 'owner_unavailable') {
        skippedCount++
        continue
      }
      if (ack.status === 'not_eligible') {
        pendingCount++
        continue
      }
      if (ack.status !== 'qualified' && ack.status !== 'already_qualified') {
        failedCount++
        logger.error('[qualify-referrals] qualification returned an unhandled status', {
          attributionId: candidate.id,
        })
        continue
      }

      if (ack.status === 'qualified') qualifiedCount++
      if (ack.friendStatus === 'granted') {
        friendGrants++
        sendNotification(
          supabase,
          {
            user_id: ack.referredId,
            type: 'referral_reward',
            title: 'Welcome — Pro trial unlocked!',
            message: `You joined via a referral and earned ${REFERRED_FRIEND_TRIAL_DAYS} days of Arena Pro. Enjoy!`,
            link: '/settings',
            reference_id: `friend:${ack.attributionId}`,
          },
          'Referral friend reward notification'
        )
      }
      if (ack.advocateStatus === 'granted' && ack.advocateRewardId) {
        advocateGrants++
        sendNotification(
          supabase,
          {
            user_id: ack.referrerId,
            type: 'referral_reward',
            title: 'Referral reward earned!',
            message: `You referred ${REFERRAL_REWARD_THRESHOLD} friends and earned ${REFERRAL_ADVOCATE_PRO_DAYS} days of Pro! Thank you for spreading the word.`,
            link: '/settings',
            reference_id: `advocate:${ack.advocateRewardId}`,
          },
          'Referral advocate reward notification'
        )
      }
      if (
        ack.qualifiedReferralCount >= REFERRAL_REWARD_THRESHOLD &&
        ack.qualifiedWindowMinutes !== null &&
        ack.qualifiedWindowMinutes < REFERRAL_VELOCITY_ALERT_MINUTES
      ) {
        logger.warn(
          `[qualify-referrals] VELOCITY FLAG referrer=${ack.referrerId} — ${ack.qualifiedReferralCount} qualified referrals within ${Math.round(ack.qualifiedWindowMinutes)}min (threshold ${REFERRAL_VELOCITY_ALERT_MINUTES}min); possible farm, review`
        )
      }
    }

    logger.info(
      `[qualify-referrals] qualified=${qualifiedCount} friendGrants=${friendGrants} advocateGrants=${advocateGrants} pending=${pendingCount} skipped=${skippedCount} failed=${failedCount}`
    )
    if (failedCount > 0) {
      const failure = new Error(
        `Referral qualification left ${failedCount} retryable atomic outcome(s)`
      )
      await plog.error(failure)
      return NextResponse.json(
        {
          error: 'Referral qualification incomplete',
          qualified: qualifiedCount,
          friendGrants,
          advocateGrants,
          pending: pendingCount,
          skipped: skippedCount,
          failed: failedCount,
        },
        { status: 500 }
      )
    }

    await plog.success(qualifiedCount)
    return NextResponse.json({
      status: 'ok',
      qualified: qualifiedCount,
      friendGrants,
      advocateGrants,
      pending: pendingCount,
      skipped: skippedCount,
      failed: failedCount,
    })
  } catch (err) {
    logger.error('[qualify-referrals] failed', err)
    await plog.error(err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  } finally {
    releaseLock()
  }
}
