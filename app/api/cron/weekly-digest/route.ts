/**
 * Weekly Email Digest Cron
 *
 * Runs every Monday 09:00 UTC.
 * Sends a personalised digest email to users who opted in (email_digest = 'weekly').
 *
 * Content: top movers this week, new trader count, total tracked.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { PipelineLogger } from '@/lib/services/pipeline-logger'
import { sendEmail, buildWeeklyDigestEmail } from '@/lib/services/email'
import { generateUnsubscribeToken } from '@/lib/utils/unsubscribe-token'
import { BASE_URL } from '@/lib/constants/urls'
import { env } from '@/lib/env'
import { createLogger } from '@/lib/utils/logger'
import { verifyCronSecret } from '@/lib/auth/verify-service-auth'

const logger = createLogger('weekly-digest')

export const dynamic = 'force-dynamic'
export const maxDuration = 120

export async function GET(request: NextRequest) {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const plog = await PipelineLogger.start('weekly-digest')

  try {
    const supabase = getSupabaseAdmin() as SupabaseClient
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    const weekAgoIso = weekAgo.toISOString()

    // 1. Fetch users who opted in to weekly digest and have an email
    const { data: subscribers, error: subErr } = await supabase
      .from('user_profiles')
      .select('id, handle')
      .eq('email_digest', 'weekly')

    if (subErr) {
      logger.error('Failed to fetch subscribers', { error: subErr.message })
      await plog.error(new Error(subErr.message))
      return NextResponse.json({ error: subErr.message }, { status: 500 })
    }

    if (!subscribers || subscribers.length === 0) {
      logger.info('No weekly digest subscribers')
      await plog.success(0, { reason: 'no subscribers' })
      return NextResponse.json({ ok: true, sent: 0 })
    }

    // Resolve emails from auth.users via admin API
    // We batch-fetch subscriber user IDs
    const _subscriberIds = subscribers.map(s => s.id)

    // 2. Get top movers (biggest rank changes this week)
    const { data: movers } = await supabase
      .from('trader_snapshots_v2')
      .select('source_trader_id, platform, display_name, roi_pct, previous_roi_pct:roi_pct')
      .gte('updated_at', weekAgoIso)
      .not('roi_pct', 'is', null)
      .order('roi_pct', { ascending: false })
      .limit(10)

    const topMovers = (movers || []).map(m => ({
      name: m.display_name || m.source_trader_id,
      change: `${(m.roi_pct ?? 0) > 0 ? '+' : ''}${((m.roi_pct ?? 0)).toFixed(1)}% ROI`,
      link: `/trader/${encodeURIComponent(m.display_name || m.source_trader_id)}?platform=${m.platform}`,
    }))

    // 3. New traders this week
    // Estimated is fine — this is a marketing email headline number, not
    // a financial report. Exact on trader_sources (~34k rows) can be slow
    // under cron contention.
    const { count: newTraders } = await supabase
      .from('trader_sources')
      .select('id', { count: 'estimated', head: true })
      .gte('created_at', weekAgoIso)

    // 4. Total tracked (estimated — marketing headline)
    const { count: totalTracked } = await supabase
      .from('trader_sources')
      .select('id', { count: 'estimated', head: true })

    // 5. Week range string
    const now = new Date()
    const weekRange = `${weekAgo.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`

    // 6. Send emails to each subscriber
    let sentCount = 0
    let failCount = 0

    for (const sub of subscribers) {
      try {
        // Get user email from Supabase Auth
        const { data: { user } } = await supabase.auth.admin.getUserById(sub.id)
        if (!user?.email) {
          logger.warn('Subscriber has no email', { userId: sub.id })
          continue
        }

        const unsubToken = generateUnsubscribeToken(sub.id, 'digest')
        const unsubLink = `${BASE_URL}/api/email/unsubscribe?token=${unsubToken}`

        const html = buildWeeklyDigestEmail({
          topMovers,
          newTraders: newTraders ?? 0,
          totalTracked: totalTracked ?? 0,
          weekRange,
        }) + `
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

    logger.info('Weekly digest complete', { sent: sentCount, failed: failCount, subscribers: subscribers.length })
    await plog.success(sentCount, { failed: failCount, subscribers: subscribers.length })

    return NextResponse.json({
      ok: true,
      sent: sentCount,
      failed: failCount,
      subscribers: subscribers.length,
      topMovers: topMovers.length,
      newTraders: newTraders ?? 0,
    })
  } catch (err) {
    logger.error('Weekly digest cron failed', { error: err instanceof Error ? err.message : String(err) })
    await plog.error(err instanceof Error ? err : new Error(String(err)))
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
