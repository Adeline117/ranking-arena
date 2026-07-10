/**
 * GET /api/cron/compute-leaderboard-watchdog — Vercel-side safety net for the
 * compute-leaderboard chain.
 *
 * WHY: compute-leaderboard is NOT a Vercel cron — it is triggered by the Mac
 * Mini ingest worker (every 2h, `worker/src/scheduler.ts`). If that worker or
 * the trigger chain dies, serving leaderboards silently stop recomputing while
 * `sync-ranking-store` keeps publishing the stale ranks. Detection already
 * exists (meta-monitor / worker-heartbeat), but recovery was MANUAL. This
 * watchdog closes that gap: if serving is stale beyond one full compute cycle,
 * it fires the compute itself and alerts.
 *
 * SAFETY: compute-leaderboard holds a Redis idempotency lock
 * (`cron:compute-leaderboard:running`), so a double-trigger (worker + watchdog)
 * is a no-op — the second caller skips. We fire only 90D (the flagship) per
 * tick to stay bounded; a subsequent tick re-fires if still stale.
 */

import { NextRequest } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { withCron } from '@/lib/api/with-cron'
import { sendAlert } from '@/lib/alerts/send-alert'
import { logger } from '@/lib/logger'

export const dynamic = 'force-dynamic'
export const maxDuration = 90

// Compute runs every 2h normally; health tolerates 4h. Intervene at 3h — one
// full cycle definitively missed, but before the health SLO trips.
const STALE_MS = 3 * 3600_000

export const GET = withCron(
  'compute-leaderboard-watchdog',
  async (_request: NextRequest, { supabase }) => {
    const { data, error } = await (supabase as SupabaseClient)
      .from('leaderboard_ranks')
      .select('computed_at')
      .order('computed_at', { ascending: false })
      .limit(1)

    if (error) {
      logger.error('[compute-watchdog] freshness query failed:', error.message)
      return { checked: false, error: error.message }
    }

    const newestIso = data?.[0]?.computed_at as string | undefined
    const ageMs = newestIso ? Date.now() - new Date(newestIso).getTime() : Infinity
    const ageMin = Number.isFinite(ageMs) ? Math.round(ageMs / 60_000) : -1

    if (ageMs <= STALE_MS) {
      return { stale: false, age_minutes: ageMin }
    }

    // Stalled — the worker-triggered chain has not recomputed in > 3h. Fire the
    // flagship 90D compute ourselves. Await briefly to confirm it started; the
    // compute endpoint runs to completion independently of this request, and its
    // Redis lock dedups against any concurrent worker trigger.
    const base = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.arenafi.org'
    const secret = process.env.CRON_SECRET
    let triggered = false
    let triggerNote = ''
    if (secret) {
      try {
        const resp = await fetch(`${base}/api/cron/compute-leaderboard?season=90D`, {
          headers: { Authorization: `Bearer ${secret}` },
          signal: AbortSignal.timeout(60_000),
        })
        triggered = true
        triggerNote = `HTTP ${resp.status}`
      } catch (e) {
        // Timeout/abort is expected — compute is long-running and continues on
        // its own invocation. Treat "kicked" as triggered.
        triggered = true
        triggerNote =
          e instanceof Error && e.name === 'TimeoutError'
            ? 'kicked (still running)'
            : `err ${String(e)}`
      }
    } else {
      triggerNote = 'CRON_SECRET missing — cannot trigger'
    }

    await sendAlert({
      level: 'critical',
      title: 'compute-leaderboard 看门狗触发',
      message: `服务层 leaderboard 已 ${ageMin} 分钟未重算(>3h)——Mac Mini worker 触发链可能已死。看门狗已${triggered ? '兜底触发 90D' : '尝试触发但失败'}(${triggerNote})。请检查 worker。`,
      details: { age_minutes: ageMin, triggered, triggerNote },
    }).catch((e) => logger.error('[compute-watchdog] alert failed:', e))

    return { stale: true, age_minutes: ageMin, triggered, triggerNote }
  }
)
