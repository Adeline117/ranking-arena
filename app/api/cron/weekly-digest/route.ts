/**
 * Weekly Email Digest Cron
 *
 * Runs every Monday 09:00 UTC.
 * Sends a personalised digest email to users who opted in (email_digest = 'weekly').
 *
 * Content: top movers this week, new trader count, total tracked.
 */

import { NextRequest } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { sendEmail, buildWeeklyDigestEmail } from '@/lib/services/email'
import { generateUnsubscribeToken } from '@/lib/utils/unsubscribe-token'
import { BASE_URL } from '@/lib/constants/urls'
import { createLogger } from '@/lib/utils/logger'
import { withCron } from '@/lib/api/with-cron'
import { isPublicRankingSourceAllowed } from '@/lib/rankings/publication-policy'
import { readSealedRankingAuthorityGeneration } from '@/lib/rankings/read-sealed-ranking-generation'
import {
  buildFollowedDigestActivity,
  buildWeeklyDigestDeliveryKey,
  indexDigestActivities,
  indexDigestFollows,
  readAllPages,
  type DigestActivityRow,
  type DigestFollowRow,
} from './personalization'

const logger = createLogger('weekly-digest')
const WORK_BUDGET_MS = 100_000
const EMAIL_SEND_TIMEOUT_MS = 8_000
const DELIVERY_CLEANUP_RESERVE_MS = 5_000

function waitForSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    operation.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      }
    )
  })
}

export const dynamic = 'force-dynamic'
export const maxDuration = 120

export const GET = withCron('weekly-digest', async (_request: NextRequest) => {
  const supabase = getSupabaseAdmin()
  const now = new Date()
  const workDeadlineMs = now.getTime() + WORK_BUDGET_MS
  const workSignal = AbortSignal.timeout(WORK_BUDGET_MS)
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
  const weekAgoIso = weekAgo.toISOString()

  // 1. Fetch users who opted in to weekly digest and have an email
  const { data: subscribers, error: subErr } = await readAllPages<{
    id: string
    handle: string | null
  }>((from, to) =>
    supabase
      .from('user_profiles')
      .select('id, handle')
      .eq('email_digest', 'weekly')
      .order('id', { ascending: true })
      .range(from, to)
      .abortSignal(workSignal)
  )

  if (subErr) {
    logger.error('Failed to fetch subscribers', { error: subErr.message })
    throw new Error(subErr.message)
  }

  if (subscribers.length === 0) {
    logger.info('No weekly digest subscribers')
    return { count: 0, reason: 'no subscribers' }
  }

  // 2. Top movers (biggest 7D ROI this week). Migrated off retiring trader_latest
  // → leaderboard_ranks (source↔platform, handle↔display_name, roi↔roi_pct).
  const sealedMovers = await readSealedRankingAuthorityGeneration(
    supabase,
    '7D',
    async (publication) => {
      const authoritySources = publication.proofs.map((proof) => proof.source)
      const { data, error } = await supabase
        .from('leaderboard_ranks')
        .select('source_trader_id, source, handle, roi')
        .in('source', authoritySources)
        .eq('season_id', '7D')
        .filter('rank_publication_id', 'eq', publication.scoreCohortId)
        .gte('computed_at', weekAgoIso)
        .not('roi', 'is', null)
        .gt('arena_score', 0)
        .or('is_outlier.is.null,is_outlier.eq.false')
        .order('roi', { ascending: false })
        .order('source', { ascending: true })
        .order('source_trader_id', { ascending: true })
        .limit(10)
        .abortSignal(workSignal)

      if (error || data === null) {
        throw new Error(`Failed to load weekly movers: ${error?.message ?? 'null payload'}`)
      }
      if (data.some((row) => !isPublicRankingSourceAllowed(row.source))) {
        throw new Error('weekly digest ranking query crossed the public source boundary')
      }
      return data
    },
    { timeoutMs: 15_000 }
  )
  const movers = sealedMovers.value

  const topMovers = (movers || []).map((m) => ({
    name: m.handle || m.source_trader_id,
    change: `${(m.roi ?? 0) > 0 ? '+' : ''}${(m.roi ?? 0).toFixed(1)}% ROI`,
    link: `/trader/${encodeURIComponent(m.handle || m.source_trader_id)}?platform=${m.source}`,
  }))

  // 3. New traders this week
  const { count: newTraders, error: newTradersError } = await supabase
    .from('trader_sources')
    .select('id', { count: 'estimated', head: true })
    .gte('created_at', weekAgoIso)
    .abortSignal(workSignal)
  if (newTradersError) {
    throw new Error(`Failed to load weekly new-trader count: ${newTradersError.message}`)
  }

  // 4. Total tracked
  const { count: totalTracked, error: totalTrackedError } = await supabase
    .from('trader_sources')
    .select('id', { count: 'estimated', head: true })
    .abortSignal(workSignal)
  if (totalTrackedError) {
    throw new Error(`Failed to load total trader count: ${totalTrackedError.message}`)
  }

  // 5. Week range string
  const weekRange = `${weekAgo.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`

  // 5b. Per-user personalization — what each subscriber's FOLLOWED traders did
  // this week. Two batched queries (follows, then activities for the union of
  // followed traders), grouped in memory. No N+1 per user. Subscribers with no
  // follows / no followed-trader activity fall back to the global digest below.
  // Join by the complete exchange-account identity. Any remaining source=NULL
  // follow is ambiguous/unresolved legacy data and is deliberately skipped.
  const subscriberIdList = subscribers.map((s) => s.id)
  const followRows: DigestFollowRow[] = []
  for (let i = 0; i < subscriberIdList.length; i += 500) {
    const chunk = subscriberIdList.slice(i, i + 500)
    const { data: follows, error: fErr } = await readAllPages<DigestFollowRow>((from, to) =>
      supabase
        .from('trader_follows')
        .select('user_id, trader_id, source')
        .in('user_id', chunk)
        .order('id', { ascending: true })
        .range(from, to)
        .abortSignal(workSignal)
    )
    if (fErr) {
      throw new Error(`Failed to load digest follows: ${fErr.message}`)
    }
    followRows.push(...follows)
  }
  const { followsByUser, accountsBySource } = indexDigestFollows(followRows)

  const activityRows: DigestActivityRow[] = []
  for (const [source, sourceTraderIds] of accountsBySource) {
    if (!isPublicRankingSourceAllowed(source)) continue
    const followedIdList = [...sourceTraderIds]
    for (let i = 0; i < followedIdList.length; i += 300) {
      const chunk = followedIdList.slice(i, i + 300)
      const { data: acts, error: aErr } = await readAllPages<DigestActivityRow>((from, to) =>
        supabase
          .from('trader_activities')
          .select('id, source_trader_id, source, handle, activity_text, occurred_at')
          .eq('source', source)
          .in('source_trader_id', chunk)
          .gte('occurred_at', weekAgoIso)
          .order('occurred_at', { ascending: false })
          .order('id', { ascending: false })
          .range(from, to)
          .abortSignal(workSignal)
      )
      if (aErr) {
        throw new Error(`Failed to load digest activities for ${source}: ${aErr.message}`)
      }
      activityRows.push(...acts)
    }
  }
  const activityByAccount = indexDigestActivities(activityRows)

  // 6. Batch-fetch emails via paginated listUsers (replaces N+1 getUserById)
  const subscriberIds = new Set(subscribers.map((s) => s.id))
  const emailMap = new Map<string, string>()
  let page = 1
  const perPage = 1000
  while (true) {
    const {
      data: { users },
      error: listErr,
    } = await waitForSignal(supabase.auth.admin.listUsers({ page, perPage }), workSignal)
    if (listErr) throw new Error(`Failed to load digest subscriber emails: ${listErr.message}`)
    if (!users || users.length === 0) break
    for (const u of users) {
      if (subscriberIds.has(u.id) && u.email) {
        emailMap.set(u.id, u.email)
      }
    }
    if (users.length < perPage) break
    page++
  }

  // 7. Send emails with bounded concurrency to avoid timeout
  let sentCount = 0
  let failCount = 0
  let personalizedCount = 0
  const CONCURRENCY = 10
  const sendOne = async (sub: (typeof subscribers)[number]) => {
    try {
      const email = emailMap.get(sub.id)
      if (!email) {
        logger.warn('Subscriber has no email', { userId: sub.id })
        return
      }
      const user = { email }

      const unsubToken = generateUnsubscribeToken(sub.id, 'digest')
      const unsubLink = `${BASE_URL}/api/email/unsubscribe?token=${unsubToken}`

      const followedActivity = buildFollowedDigestActivity(sub.id, followsByUser, activityByAccount)
      if (followedActivity.length > 0) personalizedCount++

      const html =
        buildWeeklyDigestEmail({
          topMovers,
          newTraders: newTraders ?? 0,
          totalTracked: totalTracked ?? 0,
          weekRange,
          followedActivity,
        }) +
        `
        <div style="max-width: 600px; margin: 0 auto; padding: 0 24px 24px;">
          <p style="font-size: 11px; color: #64748b; text-align: center;">
            <a href="${unsubLink}" style="color: #6366f1;">Unsubscribe from digest</a> &middot;
            <a href="${BASE_URL}/settings#notifications" style="color: #6366f1;">Manage preferences</a>
          </p>
        </div>
      `

      const sent = await sendEmail({
        to: user.email,
        subject: `Arena Weekly Digest — ${weekRange}`,
        html,
        idempotencyKey: buildWeeklyDigestDeliveryKey(sub.id, now),
        timeoutMs: EMAIL_SEND_TIMEOUT_MS,
      })

      if (sent) {
        sentCount++
      } else {
        failCount++
      }
    } catch (err) {
      logger.error('Failed to send digest to subscriber', {
        userId: sub.id,
        error: err instanceof Error ? err.message : String(err),
      })
      failCount++
    }
  }

  // Execute sends with bounded concurrency
  for (let i = 0; i < subscribers.length; i += CONCURRENCY) {
    if (
      workSignal.aborted ||
      Date.now() + EMAIL_SEND_TIMEOUT_MS + DELIVERY_CLEANUP_RESERVE_MS >= workDeadlineMs
    ) {
      throw new Error(
        `Weekly digest work budget exhausted after ${i}/${subscribers.length} subscribers; delivery keys make retry safe`
      )
    }
    const batch = subscribers.slice(i, i + CONCURRENCY)
    await Promise.all(batch.map(sendOne))
  }

  logger.info('Weekly digest complete', {
    sent: sentCount,
    failed: failCount,
    personalized: personalizedCount,
    subscribers: subscribers.length,
  })
  return {
    count: sentCount,
    failed: failCount,
    personalized: personalizedCount,
    subscribers: subscribers.length,
    topMovers: topMovers.length,
    newTraders: newTraders ?? 0,
  }
}, { safetyTimeoutMs: 115_000 })
