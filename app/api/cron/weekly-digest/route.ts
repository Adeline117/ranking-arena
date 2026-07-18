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
import type { SupabaseClient } from '@supabase/supabase-js'
import { sendEmail, buildWeeklyDigestEmail } from '@/lib/services/email'
import { generateUnsubscribeToken } from '@/lib/utils/unsubscribe-token'
import { BASE_URL } from '@/lib/constants/urls'
import { createLogger } from '@/lib/utils/logger'
import { withCron } from '@/lib/api/with-cron'
import {
  buildFollowedDigestActivity,
  indexDigestActivities,
  indexDigestFollows,
  readAllPages,
  type DigestActivityRow,
  type DigestFollowRow,
} from './personalization'

const logger = createLogger('weekly-digest')

export const dynamic = 'force-dynamic'
export const maxDuration = 120

export const GET = withCron('weekly-digest', async (_request: NextRequest) => {
  const supabase = getSupabaseAdmin() as SupabaseClient
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
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
  const { data: movers } = await supabase
    .from('leaderboard_ranks')
    .select('source_trader_id, source, handle, roi')
    .eq('season_id', '7D')
    .gte('computed_at', weekAgoIso)
    .not('roi', 'is', null)
    .order('roi', { ascending: false })
    .limit(10)

  const topMovers = (movers || []).map((m) => ({
    name: m.handle || m.source_trader_id,
    change: `${(m.roi ?? 0) > 0 ? '+' : ''}${(m.roi ?? 0).toFixed(1)}% ROI`,
    link: `/trader/${encodeURIComponent(m.handle || m.source_trader_id)}?platform=${m.source}`,
  }))

  // 3. New traders this week
  const { count: newTraders } = await supabase
    .from('trader_sources')
    .select('id', { count: 'estimated', head: true })
    .gte('created_at', weekAgoIso)

  // 4. Total tracked
  const { count: totalTracked } = await supabase
    .from('trader_sources')
    .select('id', { count: 'estimated', head: true })

  // 5. Week range string
  const now = new Date()
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
    )
    if (fErr) {
      logger.warn('Failed to fetch follows chunk (skipping personalization for chunk)', {
        error: fErr.message,
      })
      continue
    }
    followRows.push(...follows)
  }
  const { followsByUser, accountsBySource } = indexDigestFollows(followRows)

  const activityRows: DigestActivityRow[] = []
  for (const [source, sourceTraderIds] of accountsBySource) {
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
      )
      if (aErr) {
        logger.warn('Failed to fetch activities chunk (skipping personalization for chunk)', {
          source,
          error: aErr.message,
        })
        continue
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
    } = await supabase.auth.admin.listUsers({ page, perPage })
    if (listErr || !users || users.length === 0) break
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
})
