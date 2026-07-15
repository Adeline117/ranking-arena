/**
 * Weekly Product Metrics Cron
 *
 * GET /api/cron/weekly-metrics  (CRON_SECRET header required)
 *
 * Vercel-native counterpart to scripts/openclaw/weekly-metrics.mjs. Computes
 * the database-owned B2C acquisition, activation, activity, payment and
 * journey facts, adds leaderboard trust, and pushes them to Telegram.
 *
 * Scheduled at Friday 09:00 UTC in vercel.json.
 *
 * First adopter of withCronBudget — validates the auth + lock + plog +
 * time-budget unification in a real cron.
 */

import type { NextRequest } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { sendTelegramAlert } from '@/lib/notifications/telegram'
import { withCronBudget } from '@/lib/cron/with-cron-budget'
import { createLogger } from '@/lib/utils/logger'
import { parseB2CProductMetrics } from '@/lib/analytics/b2c-metrics'

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
      const [metricsRes, trustRes] = await Promise.allSettled([
        supabase.rpc('b2c_product_metrics', { p_window_days: 7 }),
        // Trust ratio — uses the dedicated RPC added in
        // 20260409173653_get_top_trust_ratio_rpc.sql. Replaces the previous
        // N+1 REST loop that timed out at the 30s Supabase limit.
        supabase.rpc('get_top_trust_ratio', { p_season_id: '90D', p_top_n: 10 }),
      ])

      const metrics =
        metricsRes.status === 'fulfilled' && !metricsRes.value.error
          ? parseB2CProductMetrics(metricsRes.value.data)
          : null

      let trustFull: number | null = null
      let trustTotal: number | null = null
      let trustRatio: number | null = null
      if (trustRes.status === 'fulfilled' && trustRes.value.data) {
        const row = Array.isArray(trustRes.value.data)
          ? trustRes.value.data[0]
          : trustRes.value.data
        if (row) {
          trustFull = Number(row.full_count) || 0
          trustTotal = Number(row.total_count) || 0
          trustRatio = Number(row.ratio) || 0
        }
      }

      // Log any failed sub-queries (non-fatal — Telegram still gets partial data)
      if (!metrics) logger.warn('B2C metrics contract unavailable')
      if (trustRes.status === 'rejected') logger.warn('trustRatio failed', trustRes.reason)

      const activationRate =
        metrics && metrics.activationEligible > 0
          ? Math.round((metrics.activated7d / metrics.activationEligible) * 100)
          : null
      const funnel = metrics?.funnel ?? {}

      const lines = [
        '<b>📊 Arena Weekly Metrics</b>',
        '',
        `<b>WAU (7d):</b> ${metrics?.wau ?? '<i>n/a</i>'}`,
        `<b>Total paying:</b> ${metrics?.totalPaying ?? '<i>failed</i>'}`,
        `<b>New paying this week:</b> ${metrics?.newPaying ?? '<i>failed</i>'}`,
        `<b>New signups:</b> ${metrics?.newSignups ?? '<i>failed</i>'}`,
        `<b>7d activation:</b> ${metrics ? `${metrics.activated7d}/${metrics.activationEligible}${activationRate === null ? '' : ` (${activationRate}%)`}` : '<i>failed</i>'}`,
        `<b>Journey:</b> ${funnel.landing_view ?? 0} land → ${funnel.ranking_visible ?? 0} rank → ${funnel.view_trader ?? 0} trader → ${funnel.signup ?? 0} signup → ${funnel.start_checkout ?? 0} checkout`,
        `<i>Event collection: ${metrics?.eventCollectionStartedAt ?? 'not started; funnel zeros are not historical zeros'}</i>`,
        trustRatio != null && trustTotal
          ? `<b>Top-10 trust (full):</b> ${trustFull}/${trustTotal} (${Math.round(trustRatio * 100)}%)`
          : '<b>Top-10 trust:</b> <i>failed</i>',
        '',
        `<i>${new Date().toISOString()}</i>`,
      ]

      // level: 'report' — bypasses 'info' (log-only) and 'warning' (digest)
      // so the weekly push is guaranteed to reach Telegram.
      await sendTelegramAlert({
        level: 'report',
        source: 'weekly-metrics',
        title: 'Arena Weekly Metrics',
        message: lines.join('\n'),
      })

      return {
        recordsProcessed: 4,
        metadata: {
          metrics,
          trustFull,
          trustTotal,
          trustRatio,
        },
      }
    }
  )
}
