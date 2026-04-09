/**
 * Admin Pro Metrics API
 *
 * GET /api/admin/pro-metrics
 * Returns the paying-subscriber KPIs the CEO review 2026-04-09 flagged as
 * the three numbers that matter most:
 *   - total paying (active + trialing, pro + lifetime)
 *   - signups this week (created_at >= 7d ago, paying only)
 *   - WAU (distinct user_ids in user_activity, 7d)
 *   - recent paying signups (last 10)
 *
 * Weekly Telegram script (scripts/openclaw/weekly-metrics.mjs) covers the
 * same data surface for the "report to Telegram" channel; this endpoint
 * powers the /admin/pro-metrics dashboard for at-a-glance viewing.
 */

import { withAdminAuth } from '@/lib/api/with-admin-auth'
import { success as apiSuccess } from '@/lib/api/response'
import { createLogger } from '@/lib/utils/logger'

const logger = createLogger('admin-pro-metrics')

export const dynamic = 'force-dynamic'

export const GET = withAdminAuth(
  async ({ supabase }) => {
    const now = new Date()
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)

    // All read-only queries in parallel — they don't depend on each other.
    const [
      totalPayingRes,
      newPayingThisWeekRes,
      activityRes,
      recentSignupsRes,
    ] = await Promise.allSettled([
      // Total active paying subscribers
      supabase
        .from('subscriptions')
        .select('id', { count: 'estimated', head: true })
        .in('status', ['active', 'trialing'])
        .in('tier', ['pro', 'lifetime']),
      // Paying subscribers that signed up in the last 7 days
      supabase
        .from('subscriptions')
        .select('id', { count: 'estimated', head: true })
        .in('status', ['active', 'trialing'])
        .in('tier', ['pro', 'lifetime'])
        .gte('created_at', weekAgo.toISOString()),
      // WAU: distinct user_ids in user_activity for the last 7d.
      // Fetch user_ids and dedupe client-side (Supabase REST has no DISTINCT).
      // Capped at 50k rows which is enough for current user base.
      supabase
        .from('user_activity')
        .select('user_id')
        .gte('created_at', weekAgo.toISOString())
        .limit(50_000),
      // Recent paying signups — last 10 across pro+lifetime
      supabase
        .from('subscriptions')
        .select('id, user_id, tier, plan, status, created_at')
        .in('status', ['active', 'trialing'])
        .in('tier', ['pro', 'lifetime'])
        .order('created_at', { ascending: false })
        .limit(10),
    ])

    const totalPaying =
      totalPayingRes.status === 'fulfilled' ? totalPayingRes.value.count ?? 0 : null
    const newPayingThisWeek =
      newPayingThisWeekRes.status === 'fulfilled'
        ? newPayingThisWeekRes.value.count ?? 0
        : null

    let wau: number | null = null
    if (activityRes.status === 'fulfilled' && activityRes.value.data) {
      const unique = new Set((activityRes.value.data as Array<{ user_id: string }>).map((r) => r.user_id))
      wau = unique.size
    }

    const recentSignups =
      recentSignupsRes.status === 'fulfilled' && recentSignupsRes.value.data
        ? (recentSignupsRes.value.data as Array<{
            id: string
            user_id: string
            tier: string
            plan: string | null
            status: string
            created_at: string
          }>)
        : []

    // Log any failed sub-queries (non-fatal — dashboard surfaces partial data)
    if (totalPayingRes.status === 'rejected') logger.warn('totalPaying failed', totalPayingRes.reason)
    if (newPayingThisWeekRes.status === 'rejected') logger.warn('newPaying failed', newPayingThisWeekRes.reason)
    if (activityRes.status === 'rejected') logger.warn('activity failed', activityRes.reason)
    if (recentSignupsRes.status === 'rejected') logger.warn('recentSignups failed', recentSignupsRes.reason)

    return apiSuccess({
      totalPaying,
      newPayingThisWeek,
      wau,
      recentSignups,
      windowDays: 7,
      timestamp: new Date().toISOString(),
    })
  },
  { name: 'admin-pro-metrics' },
)
