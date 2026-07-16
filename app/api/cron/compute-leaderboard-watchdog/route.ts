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

export const dynamic = 'force-dynamic'
export const maxDuration = 90

// Compute runs every 2h normally; health tolerates 4h. Intervene at 3h — one
// full cycle definitively missed, but before the health SLO trips.
const STALE_MS = 3 * 3600_000

const SEASONS = ['90D', '30D', '7D'] as const

export const GET = withCron(
  'compute-leaderboard-watchdog',
  async (_request: NextRequest, { supabase }) => {
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
        if (error) return { season, error: error.message, ageMs: null as number | null, ageMin: -1 }
        const iso = data?.[0]?.computed_at as string | undefined
        const ageMs = iso ? Date.now() - new Date(iso).getTime() : Infinity
        const ageMin = Number.isFinite(ageMs) ? Math.round(ageMs / 60_000) : -1
        return { season, error: null as string | null, ageMs, ageMin }
      })
    )

    const queryErr = freshness.find((f) => f.error)
    if (queryErr) {
      logger.error('[compute-watchdog] freshness query failed:', queryErr.error)
      return { checked: false, error: queryErr.error }
    }

    const staleSeasons = freshness.filter((f) => f.ageMs == null || (f.ageMs ?? 0) > STALE_MS)
    if (staleSeasons.length === 0) {
      return { stale: false, ages: freshness.map((f) => ({ [f.season]: f.ageMin })) }
    }

    // One or more seasons stalled > 3h — the worker-triggered chain missed them.
    // Fire each stale season's compute ourselves. The compute endpoint's Redis
    // idempotency lock dedups against any concurrent worker trigger, so a
    // double-fire is a no-op. Timeout/abort is expected (compute is long-running
    // and continues on its own invocation) — treat "kicked" as triggered.
    const base = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.arenafi.org'
    const secret = process.env.CRON_SECRET
    const triggers: Array<{ season: string; triggered: boolean; note: string }> = []
    for (const s of staleSeasons) {
      if (!secret) {
        triggers.push({ season: s.season, triggered: false, note: 'CRON_SECRET missing' })
        continue
      }
      try {
        const resp = await fetch(`${base}/api/cron/compute-leaderboard?season=${s.season}`, {
          headers: { Authorization: `Bearer ${secret}` },
          signal: AbortSignal.timeout(60_000),
        })
        triggers.push({ season: s.season, triggered: true, note: `HTTP ${resp.status}` })
      } catch (e) {
        triggers.push({
          season: s.season,
          triggered: true,
          note:
            e instanceof Error && e.name === 'TimeoutError'
              ? 'kicked (still running)'
              : `err ${String(e)}`,
        })
      }
    }

    const staleDesc = staleSeasons.map((s) => `${s.season} ${s.ageMin}min`).join(', ')
    await sendAlert({
      level: 'critical',
      title: 'compute-leaderboard 看门狗触发',
      message: `服务层 leaderboard 部分 season 已 >3h 未重算(${staleDesc})——Mac Mini worker 触发链可能已死。看门狗已兜底触发这些 season。请检查 worker。`,
      details: { staleSeasons: staleSeasons.map((s) => ({ [s.season]: s.ageMin })), triggers },
    }).catch((e) => logger.error('[compute-watchdog] alert failed:', e))

    return { stale: true, staleSeasons: staleSeasons.map((s) => s.season), triggers }
  }
)
