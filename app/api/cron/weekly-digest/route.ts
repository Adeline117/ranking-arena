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
import { sanitizePublicRankingPayload } from '@/lib/rankings/publication-policy'
import { readAllPages } from './personalization'

const logger = createLogger('weekly-digest')
const PUBLIC_RANKED_LEADERBOARD = 'public_ranked_leaderboard' as const
const PUBLIC_RANKING_COLUMNS =
  'season_id,source,source_trader_id,handle,roi,pnl,arena_score,rank,win_rate,max_drawdown,score_completeness,metrics_estimated,is_outlier,computed_at'

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

  // This is an external ranking surface. No raw row or cached ranking excerpt
  // may become email content; an unavailable cohort simply has no Top Movers
  // section for this issue.
  const { data: moverRows, error: moverErr } = await supabase
    .from(PUBLIC_RANKED_LEADERBOARD as never)
    .select(PUBLIC_RANKING_COLUMNS)
    .eq('season_id', '7D')
    .not('roi', 'is', null)
    .order('roi', { ascending: false })
    .limit(10)

  const topMovers = moverErr ? [] : verifiedDigestMovers(moverRows ?? [])
  if (moverErr) {
    logger.warn('Verified weekly mover cohort unavailable', { error: moverErr.message })
  }

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

  // Persisted activity text may contain historical raw metrics. Do not forward
  // it until it has its own immutable public-evidence contract.

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

      const html =
        buildWeeklyDigestEmail({
          topMovers,
          newTraders: newTraders ?? 0,
          totalTracked: totalTracked ?? 0,
          weekRange,
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
    subscribers: subscribers.length,
    rankingContent: topMovers.length > 0 ? 'verified' : 'omitted',
  })
  return {
    count: sentCount,
    failed: failCount,
    subscribers: subscribers.length,
    topMovers: topMovers.length,
    newTraders: newTraders ?? 0,
  }
})

function verifiedDigestMovers(
  rows: unknown[]
): Array<{ name: string; change: string; link: string }> {
  const sanitized = sanitizePublicRankingPayload(
    { traders: rows, period: '7D' },
    { expectedPeriod: '7D' }
  ) as { traders?: unknown[]; ranking_visibility?: unknown }

  if (
    sanitized.ranking_visibility === 'partial' ||
    sanitized.ranking_visibility === 'unknown' ||
    sanitized.ranking_visibility === 'error' ||
    !Array.isArray(sanitized.traders) ||
    sanitized.traders.length === 0
  ) {
    return []
  }

  const movers: Array<{ name: string; change: string; link: string }> = []
  for (const row of sanitized.traders) {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) return []
    const record = row as Record<string, unknown>
    if (
      typeof record.source !== 'string' ||
      typeof record.source_trader_id !== 'string' ||
      typeof record.roi !== 'number' ||
      !Number.isFinite(record.roi) ||
      (record.handle !== null && typeof record.handle !== 'string')
    ) {
      return []
    }
    const name = typeof record.handle === 'string' ? record.handle : record.source_trader_id
    movers.push({
      name,
      change: `${record.roi > 0 ? '+' : ''}${record.roi.toFixed(1)}% ROI`,
      link: `/trader/${encodeURIComponent(name)}?platform=${encodeURIComponent(record.source)}`,
    })
  }
  return movers
}
