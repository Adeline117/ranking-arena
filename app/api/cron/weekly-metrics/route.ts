/**
 * Weekly Product Metrics Cron
 *
 * POST /api/cron/weekly-metrics  (CRON_SECRET header required)
 *
 * Vercel-native counterpart to scripts/openclaw/weekly-metrics.mjs. Computes
 * the three numbers CEO review 2026-04-09 flagged as the post-paywall success
 * signals, and pushes them to Telegram:
 *
 *   1. Total paying subscribers (active|trialing × pro|lifetime)
 *   2. New paying signups this week (7d window)
 *   3. WAU (distinct user_activity user_ids, 7d)
 *
 * Schedule: add to vercel.json crons (recommended: Fridays 09:00 UTC)
 *
 *     { "path": "/api/cron/weekly-metrics", "schedule": "0 9 * * 5" }
 *
 * Adoption of withCronBudget — first cron to use the new wrapper, validating
 * the auth + lock + plog + time-budget unification.
 */

import type { NextRequest } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { sendTelegramAlert } from '@/lib/notifications/telegram'
import { withCronBudget } from '@/lib/cron/with-cron-budget'
import { createLogger } from '@/lib/utils/logger'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 60

const logger = createLogger('weekly-metrics')

export async function GET(request: NextRequest) {
  return withCronBudget(
    {
      jobName: 'weekly-metrics',
      lockKey: 'cron:weekly-metrics:running',
      maxDurationSec: 60,
      safetyMarginSec: 10,
      request,
    },
    async () => {
      const supabase = getSupabaseAdmin()
      const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

      // All reads in parallel — independent.
      const [totalPayingRes, newPayingRes, activityRes] = await Promise.allSettled([
        supabase
          .from('subscriptions')
          .select('id', { count: 'estimated', head: true })
          .in('status', ['active', 'trialing'])
          .in('tier', ['pro', 'lifetime']),
        supabase
          .from('subscriptions')
          .select('id', { count: 'estimated', head: true })
          .in('status', ['active', 'trialing'])
          .in('tier', ['pro', 'lifetime'])
          .gte('created_at', weekAgo),
        supabase
          .from('user_activity')
          .select('user_id')
          .gte('created_at', weekAgo)
          .limit(50_000),
      ])

      const totalPaying =
        totalPayingRes.status === 'fulfilled' ? totalPayingRes.value.count ?? 0 : null
      const newPaying =
        newPayingRes.status === 'fulfilled' ? newPayingRes.value.count ?? 0 : null
      let wau: number | null = null
      if (activityRes.status === 'fulfilled' && activityRes.value.data) {
        const unique = new Set(
          (activityRes.value.data as Array<{ user_id: string }>).map((r) => r.user_id),
        )
        wau = unique.size
      }

      // Log any failed sub-queries (non-fatal — Telegram still gets partial data)
      if (totalPayingRes.status === 'rejected') logger.warn('totalPaying failed', totalPayingRes.reason)
      if (newPayingRes.status === 'rejected') logger.warn('newPaying failed', newPayingRes.reason)
      if (activityRes.status === 'rejected') logger.warn('activity failed', activityRes.reason)

      const lines = [
        '<b>📊 Arena Weekly Metrics</b>',
        '',
        `<b>WAU (7d):</b> ${wau ?? '<i>failed</i>'}`,
        `<b>Total paying:</b> ${totalPaying ?? '<i>failed</i>'}`,
        `<b>New paying this week:</b> ${newPaying ?? '<i>failed</i>'}`,
        '',
        `<i>${new Date().toISOString()}</i>`,
      ]

      await sendTelegramAlert({
        title: 'Arena Weekly Metrics',
        message: lines.join('\n'),
        level: 'info' as const,
        details: {},
      })

      return {
        recordsProcessed: 3,
        metadata: {
          totalPaying,
          newPaying,
          wau,
        },
      }
    },
  )
}
