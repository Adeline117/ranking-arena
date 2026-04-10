/**
 * Weekly Product Metrics Cron
 *
 * GET /api/cron/weekly-metrics  (CRON_SECRET header required)
 *
 * Vercel-native counterpart to scripts/openclaw/weekly-metrics.mjs. Computes
 * the four numbers CEO review 2026-04-09 flagged as the post-paywall success
 * signals, and pushes them to Telegram:
 *
 *   1. Total paying subscribers (active|trialing × pro|lifetime)
 *   2. New paying signups this week (7d window)
 *   3. WAU (distinct user_activity user_ids, 7d)
 *   4. Top-10 trust ratio (confidence=full / 10 in 90D leaderboard)
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
      const [totalPayingRes, newPayingRes, activityRes, trustRes] = await Promise.allSettled([
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
        // Trust ratio — uses the dedicated RPC added in
        // 20260409173653_get_top_trust_ratio_rpc.sql. Replaces the previous
        // N+1 REST loop that timed out at the 30s Supabase limit.
        supabase.rpc('get_top_trust_ratio', { p_season_id: '90D', p_top_n: 10 }),
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

      let trustFull: number | null = null
      let trustTotal: number | null = null
      let trustRatio: number | null = null
      if (trustRes.status === 'fulfilled' && trustRes.value.data) {
        const row = Array.isArray(trustRes.value.data) ? trustRes.value.data[0] : trustRes.value.data
        if (row) {
          trustFull = Number(row.full_count) || 0
          trustTotal = Number(row.total_count) || 0
          trustRatio = Number(row.ratio) || 0
        }
      }

      // Log any failed sub-queries (non-fatal — Telegram still gets partial data)
      if (totalPayingRes.status === 'rejected') logger.warn('totalPaying failed', totalPayingRes.reason)
      if (newPayingRes.status === 'rejected') logger.warn('newPaying failed', newPayingRes.reason)
      if (activityRes.status === 'rejected') logger.warn('activity failed', activityRes.reason)
      if (trustRes.status === 'rejected') logger.warn('trustRatio failed', trustRes.reason)

      const lines = [
        '<b>📊 Arena Weekly Metrics</b>',
        '',
        `<b>WAU (7d):</b> ${wau ?? '<i>failed</i>'}`,
        `<b>Total paying:</b> ${totalPaying ?? '<i>failed</i>'}`,
        `<b>New paying this week:</b> ${newPaying ?? '<i>failed</i>'}`,
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
          totalPaying,
          newPaying,
          wau,
          trustFull,
          trustTotal,
          trustRatio,
        },
      }
    },
  )
}
