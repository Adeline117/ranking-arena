/**
 * Admin Pro Metrics API
 *
 * GET /api/admin/pro-metrics
 * Returns the exact database-owned B2C acquisition, activation, activity,
 * payment and journey metrics plus recent paying signups.
 *
 * Weekly Telegram script (scripts/openclaw/weekly-metrics.mjs) covers the
 * same data surface for the "report to Telegram" channel; this endpoint
 * powers the /admin/pro-metrics dashboard for at-a-glance viewing.
 */

import { withAdminAuth } from '@/lib/api/with-admin-auth'
import { success as apiSuccess } from '@/lib/api/response'
import { createLogger } from '@/lib/utils/logger'
import { parseB2CProductMetrics } from '@/lib/analytics/b2c-metrics'

const logger = createLogger('admin-pro-metrics')

export const dynamic = 'force-dynamic'

export const GET = withAdminAuth(
  async ({ supabase }) => {
    const [metricsRes, recentSignupsRes] = await Promise.allSettled([
      // One exact, server-owned KPI contract. This prevents the dashboard,
      // cron and scripts from silently defining WAU or paying differently.
      supabase.rpc('b2c_product_metrics', { p_window_days: 7 }),
      // Recent paying signups — last 10 across pro+lifetime
      supabase
        .from('subscriptions')
        .select('id, user_id, tier, plan, status, created_at')
        .in('status', ['active', 'trialing'])
        .in('tier', ['pro', 'lifetime'])
        .order('created_at', { ascending: false })
        .limit(10),
    ])

    const metrics =
      metricsRes.status === 'fulfilled' && !metricsRes.value.error
        ? parseB2CProductMetrics(metricsRes.value.data)
        : null

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
    if (!metrics) logger.warn('B2C metrics contract unavailable')
    if (recentSignupsRes.status === 'rejected')
      logger.warn('recentSignups failed', recentSignupsRes.reason)

    return apiSuccess({
      totalPaying: metrics?.totalPaying ?? null,
      newPayingThisWeek: metrics?.newPaying ?? null,
      wau: metrics?.wau ?? null,
      newSignups: metrics?.newSignups ?? null,
      activated7d: metrics?.activated7d ?? null,
      activationEligible: metrics?.activationEligible ?? null,
      funnel: metrics?.funnel ?? null,
      eventCollectionStartedAt: metrics?.eventCollectionStartedAt ?? null,
      measurementAvailable: metrics !== null,
      recentSignups,
      windowDays: metrics?.windowDays ?? 7,
      timestamp: metrics?.generatedAt ?? new Date().toISOString(),
    })
  },
  { name: 'admin-pro-metrics' }
)
