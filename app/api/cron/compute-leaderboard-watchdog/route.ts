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
 * is a no-op — the second caller skips. Freshness is checked PER SEASON
 * (7D/30D/90D) and only the stale season(s) are fired; a subsequent tick
 * re-fires any still-stale season.
 */

import { NextRequest } from 'next/server'
import { withCron } from '@/lib/api/with-cron'
import { sendAlert } from '@/lib/alerts/send-alert'
import { logger } from '@/lib/logger'
import {
  parseSeasonFreshnessPayload,
  triggerSeasonCompute,
  type ComputeTriggerResult,
} from './recovery-trigger'

export const dynamic = 'force-dynamic'
// Each stale season is deliberately kicked in sequence with a 60s request
// budget. Three stale seasons therefore need up to 180s before alert/finalize;
// the old 90s function budget killed the watchdog midway and left its own
// pipeline log stuck even though the detached computes kept running.
export const maxDuration = 240

// Compute runs every 2h normally; health tolerates 4h. Intervene at 3h — one
// full cycle definitively missed, but before the health SLO trips.
const STALE_MS = 3 * 3600_000

const SEASONS = ['90D', '30D', '7D'] as const

export const GET = withCron(
  'compute-leaderboard-watchdog',
  async (_request: NextRequest, { supabase }) => {
    const workSignal = AbortSignal.timeout(205_000)
    const freshnessSignal = AbortSignal.any([workSignal, AbortSignal.timeout(15_000)])

    // Freshness MUST be checked per-season, not globally. Seasons compute
    // independently; a single global-newest `computed_at` is dominated by
    // whichever season last succeeded, so if only 90D silently stalls while 7D
    // keeps computing, the global-newest stays fresh and the watchdog never
    // fires — the exact silent-stale-flagship failure this net exists to catch.
    const sb = supabase
    const freshness = await Promise.all(
      SEASONS.map(async (season) => {
        const { data, error } = await sb
          .from('leaderboard_ranks')
          .select('computed_at')
          .eq('season_id', season)
          .order('computed_at', { ascending: false })
          .limit(1)
          .abortSignal(freshnessSignal)
        if (error) {
          throw new Error(`Leaderboard freshness query failed for ${season}: ${error.message}`)
        }
        return { season, ...parseSeasonFreshnessPayload(data, Date.now()) }
      })
    )

    const staleSeasons = freshness.filter((f) => f.ageMs > STALE_MS)
    if (staleSeasons.length === 0) {
      return { stale: false, ages: freshness.map((f) => ({ [f.season]: f.ageMin })) }
    }

    // One or more seasons stalled > 3h — the worker-triggered chain missed them.
    // Fire each stale season's compute ourselves. The compute endpoint's Redis
    // idempotency lock dedups against any concurrent worker trigger, so a
    // double-fire is a no-op. A transport timeout is not proof that the server
    // accepted the request; only an explicit 2xx acknowledgement counts.
    const base = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.arenafi.org'
    const secret = process.env.CRON_SECRET
    const triggers: ComputeTriggerResult[] = []
    for (const s of staleSeasons) {
      if (!secret) {
        triggers.push({ season: s.season, triggered: false, note: 'CRON_SECRET missing' })
        continue
      }
      triggers.push(await triggerSeasonCompute(base, secret, s.season, { signal: workSignal }))
    }

    const failedTriggers = triggers.filter((trigger) => !trigger.triggered)
    const staleDesc = staleSeasons.map((s) => `${s.season} ${s.ageMin}min`).join(', ')
    const allAcknowledged = failedTriggers.length === 0
    const alertResult = await sendAlert({
      level: 'critical',
      title: allAcknowledged
        ? 'compute-leaderboard 看门狗触发已确认'
        : 'compute-leaderboard 看门狗触发失败',
      message: allAcknowledged
        ? `服务层 leaderboard 部分 season 已 >3h 未重算(${staleDesc})——Mac Mini worker 触发链可能已死。兜底请求已被 compute endpoint 明确认领。请检查 worker。`
        : `服务层 leaderboard 部分 season 已 >3h 未重算(${staleDesc})，且 ${failedTriggers.map((trigger) => trigger.season).join(', ')} 的兜底请求未获明确成功回执。不得视为已兜底，请立即检查 worker 与 compute endpoint。`,
      details: { staleSeasons: staleSeasons.map((s) => ({ [s.season]: s.ageMin })), triggers },
    })
    if (!alertResult.sent) {
      logger.error('[compute-watchdog] critical watchdog alert was not delivered')
    }

    if (!allAcknowledged) {
      throw new Error(
        `Leaderboard recovery trigger failed for: ${failedTriggers.map((trigger) => trigger.season).join(', ')}`
      )
    }

    return { stale: true, staleSeasons: staleSeasons.map((s) => s.season), triggers }
  },
  { safetyTimeoutMs: 230_000 }
)
